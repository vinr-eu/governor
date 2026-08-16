import {
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { AccessKeyCredential } from "../credentials";

export interface AwsCallerIdentity {
  account?: string;
  arn?: string;
  userId?: string;
}

export async function fetchAwsCallerIdentity(
  credential: AccessKeyCredential,
): Promise<AwsCallerIdentity> {
  const sts = new STSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    credentials: credential,
  });
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  return {
    account: identity.Account,
    arn: identity.Arn,
    userId: identity.UserId,
  };
}

// One set of credentials can reach buckets in any region, so every S3 call
// takes its region explicitly rather than trusting a single process-wide
// default — falls back to AWS_REGION (or us-east-1) only when the caller
// doesn't know the bucket's actual region yet (e.g. before the first
// `listS3Buckets` call reveals it).
function s3Client(credential: AccessKeyCredential, region?: string): S3Client {
  return new S3Client({
    region: region ?? process.env.AWS_REGION ?? "us-east-1",
    credentials: credential,
  });
}

// S3 rejects a bucket-scoped request made against the wrong region with a
// redirect that names the correct one — the SDK exposes that as an error
// carrying a 301 (or 400 IllegalLocationConstraint) status plus an
// `x-amz-bucket-region` response header. Presigning never sends a request
// (it's pure local signing), so the SDK's own `followRegionRedirects`
// client option can't help there — we read the header ourselves instead.
function redirectedRegion(err: unknown): string | undefined {
  const httpStatusCode = (err as { $metadata?: { httpStatusCode?: number } })
    ?.$metadata?.httpStatusCode;
  if (httpStatusCode !== 301 && httpStatusCode !== 400) return undefined;
  return (err as { $response?: { headers?: Record<string, string> } })
    ?.$response?.headers?.["x-amz-bucket-region"];
}

/**
 * Runs a bucket-scoped S3 call, and if it fails because the bucket lives in
 * a different region than guessed, retries once against the region S3
 * reports back. Returns both the result and the client that succeeded, so
 * callers needing a follow-up call (e.g. presigning) can reuse the
 * now-correct region without guessing again.
 */
async function withRegionRedirect<T>(
  credential: AccessKeyCredential,
  region: string | undefined,
  send: (client: S3Client) => Promise<T>,
): Promise<{ client: S3Client; result: T }> {
  const client = s3Client(credential, region);
  try {
    return { client, result: await send(client) };
  } catch (err) {
    const correctedRegion = redirectedRegion(err);
    if (!correctedRegion) throw err;
    const retryClient = s3Client(credential, correctedRegion);
    return { client: retryClient, result: await send(retryClient) };
  }
}

export interface S3BucketSummary {
  name: string;
  region?: string;
  creationDate?: string;
}

export async function listS3Buckets(
  credential: AccessKeyCredential,
  region?: string,
): Promise<S3BucketSummary[]> {
  const s3 = s3Client(credential, region);
  const result = await s3.send(new ListBucketsCommand({}));
  return (result.Buckets ?? [])
    .filter((bucket) => bucket.Name)
    .map((bucket) => ({
      name: bucket.Name as string,
      region: bucket.BucketRegion,
      creationDate: bucket.CreationDate?.toISOString(),
    }));
}

export interface S3ObjectSummary {
  key: string;
  size?: number;
  lastModified?: string;
  etag?: string;
}

const MAX_S3_SEARCH_RESULTS = 1000;

/**
 * Lists objects in a bucket, optionally narrowed by an S3-native prefix
 * (cheap, server-side) and/or a case-insensitive substring match against
 * the key (client-side, applied after fetching each page). Paginates until
 * `maxResults` is filled or the bucket is exhausted. `region` is just a
 * starting guess — a wrong one self-corrects via `withRegionRedirect` on
 * the first page, then every later page reuses the corrected client.
 */
export async function searchS3Objects(
  credential: AccessKeyCredential,
  bucket: string,
  options: {
    region?: string;
    prefix?: string;
    query?: string;
    maxResults?: number;
  } = {},
): Promise<S3ObjectSummary[]> {
  const maxResults = Math.min(options.maxResults ?? 200, MAX_S3_SEARCH_RESULTS);
  const query = options.query?.toLowerCase();
  const objects: S3ObjectSummary[] = [];
  let continuationToken: string | undefined;

  const fetchPage = (client: S3Client) =>
    client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: options.prefix,
        ContinuationToken: continuationToken,
      }),
    );

  const first = await withRegionRedirect(credential, options.region, fetchPage);
  let s3 = first.client;
  let page = first.result;

  while (true) {
    for (const object of page.Contents ?? []) {
      if (!object.Key) continue;
      if (query && !object.Key.toLowerCase().includes(query)) continue;
      objects.push({
        key: object.Key,
        size: object.Size,
        lastModified: object.LastModified?.toISOString(),
        etag: object.ETag,
      });
      if (objects.length >= maxResults) break;
    }

    continuationToken =
      objects.length < maxResults && page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    if (!continuationToken) break;

    page = await fetchPage(s3);
  }

  return objects;
}

const DEFAULT_PRESIGNED_URL_TTL_SECONDS = 300;
const MAX_PRESIGNED_URL_TTL_SECONDS = 3600;

/**
 * Hands back a time-limited, read-only download URL instead of the object
 * bytes or the underlying credentials — the whole point of exposing this to
 * agents rather than raw S3 access. `HeadObject` first so callers get a
 * clear "not found" instead of a signed URL to a 404 — and doubles as the
 * region probe: presigning never sends a request, so a wrong `region`
 * guess can only be caught and corrected here, before we sign.
 */
export async function createS3PresignedDownloadUrl(
  credential: AccessKeyCredential,
  bucket: string,
  key: string,
  options: { region?: string; expiresInSeconds?: number } = {},
): Promise<string> {
  const { client } = await withRegionRedirect(credential, options.region, (c) =>
    c.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
  );

  const ttl = Math.min(
    Math.max(1, options.expiresInSeconds ?? DEFAULT_PRESIGNED_URL_TTL_SECONDS),
    MAX_PRESIGNED_URL_TTL_SECONDS,
  );
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: ttl },
  );
}
