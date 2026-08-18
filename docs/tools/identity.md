# Identity

## `aws_list_profiles`

Lists the AWS profile names currently connected to this `governor serve` process (set up via
`governor setup aws --profile <name>`).

**Parameters:** none.

**Example call:**

```json
{}
```

**Example response:**

```json
{
  "profiles": ["default", "staging"]
}
```

Useful as a first call when you don't know which profile name (s) an agent should pass to every other tool's
`profile` param.

---

## `aws_get_caller_identity`

Returns the AWS account id, ARN, and user id for a connected profile by calling STS `GetCallerIdentity`. Good for
confirming which AWS account/identity a profile actually resolves to before trusting its results.

| Param     | Type   | Required | Description                            |
| --------- | ------ | -------- | -------------------------------------- |
| `profile` | string | no       | Profile name. Defaults to `"default"`. |

**Example call:**

```json
{
  "profile": "default"
}
```

**Example response:**

```json
{
  "profile": "default",
  "account": "248315219317",
  "arn": "arn:aws:iam::248315219317:user/governor",
  "userId": "AIDATTUF5RV2UXCKKEFSN"
}
```

If the profile isn't connected, every tool in this doc returns the same shape of error instead of a stack trace:

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "AWS profile \"default\" is not connected. Run `governor setup aws --profile default` first."
    }
  ]
}
```
