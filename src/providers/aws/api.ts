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
