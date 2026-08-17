# DynamoDB

## `aws_dynamodb_list_tables`

Lists every DynamoDB table visible to a connected profile in a region. Use this to discover table names before
describing, querying, or scanning one.

| Param     | Type   | Required | Description                                     |
|-----------|--------|----------|-------------------------------------------------|
| `profile` | string | no       | Profile name. Defaults to `"default"`.          |
| `region`  | string | no       | Defaults to `AWS_REGION` env, else `us-east-1`. |

**Example response:**

```json
{
  "tables": [
    "users",
    "orders",
    "orders-dlq"
  ]
}
```

---

## `aws_dynamodb_describe_table`

Returns a table's status, item count, size, primary key schema, and global secondary indexes. Use this to learn a
table's partition/sort key attribute names before calling `aws_dynamodb_query_table`.

| Param       | Type   | Required | Description        |
|-------------|--------|----------|--------------------|
| `tableName` | string | yes      | Name of the table. |
| `profile`   | string | no       | Profile name.      |
| `region`    | string | no       | Region.            |

**Example response:**

```json
{
  "name": "orders",
  "status": "ACTIVE",
  "itemCount": 184213,
  "sizeBytes": 55201984,
  "keySchema": [
    {
      "attributeName": "orderId",
      "keyType": "HASH"
    }
  ],
  "globalSecondaryIndexes": [
    {
      "name": "byCustomer",
      "keySchema": [
        {
          "attributeName": "customerId",
          "keyType": "HASH"
        }
      ]
    }
  ]
}
```

---

## `aws_dynamodb_get_item`

Fetches a single item by its exact primary key. Returns `null` (not an error) if no item has that key. Use
`aws_dynamodb_describe_table` first if you don't already know the partition/sort key attribute names.

| Param       | Type   | Required | Description                                                                                                                |
|-------------|--------|----------|----------------------------------------------------------------------------------------------------------------------------|
| `tableName` | string | yes      | Name of the table.                                                                                                         |
| `key`       | object | yes      | Primary key as plain JSON, e.g. `{"userId": "123"}` or `{"userId": "123", "createdAt": "2024-01-01"}` for a composite key. |
| `profile`   | string | no       | Profile name.                                                                                                              |
| `region`    | string | no       | Region.                                                                                                                    |

**Example call:**

```json
{
  "tableName": "orders",
  "key": {
    "orderId": "ord_9f21"
  }
}
```

**Example response:**

```json
{
  "item": {
    "orderId": "ord_9f21",
    "customerId": "cus_44",
    "total": 129.5,
    "status": "shipped"
  }
}
```

---

## `aws_dynamodb_query_table`

Runs a DynamoDB `Query`: an efficient lookup of every item sharing a partition key (and optionally a sort-key
condition), via `keyConditionExpression` using standard DynamoDB expression syntax. Requires knowing the partition key —
use `aws_dynamodb_scan_table` instead when you don't. Paginates internally up to `maxItems`.

| Param                       | Type    | Required | Description                                                                                                  |
|-----------------------------|---------|----------|--------------------------------------------------------------------------------------------------------------|
| `tableName`                 | string  | yes      | Name of the table.                                                                                           |
| `keyConditionExpression`    | string  | yes      | e.g. `"userId = :uid"` or `"userId = :uid AND createdAt > :since"`.                                          |
| `scanIndexForward`          | boolean | no       | Sort order on the sort key: `true` (default) ascending, `false` descending.                                  |
| `indexName`                 | string  | no       | Query a GSI/LSI instead of the primary key.                                                                  |
| `filterExpression`          | string  | no       | Applied after the read (doesn't reduce read cost, only what's returned), e.g. `"attr_gt(price, :minPrice)"`. |
| `expressionAttributeNames`  | object  | no       | Placeholders for attribute names colliding with reserved words, e.g. `{"#s": "status"}`.                     |
| `expressionAttributeValues` | object  | no       | Placeholder values, e.g. `{":uid": "123", ":since": "2026-01-01"}`.                                          |
| `maxItems`                  | number  | no       | Max items to return. Default 200, max 1000.                                                                  |
| `profile`                   | string  | no       | Profile name.                                                                                                |
| `region`                    | string  | no       | Region.                                                                                                      |

**Example call:**

```json
{
  "tableName": "orders",
  "keyConditionExpression": "customerId = :cid",
  "indexName": "byCustomer",
  "expressionAttributeValues": {
    ":cid": "cus_44"
  },
  "scanIndexForward": false
}
```

**Example response:**

```json
{
  "items": [
    {
      "orderId": "ord_9f21",
      "customerId": "cus_44",
      "total": 129.5
    }
  ],
  "truncated": false
}
```

---

## `aws_dynamodb_scan_table`

Runs a DynamoDB `Scan`: reads across the whole table/index rather than one partition, optionally narrowed by
`filterExpression` (applied after the read). Slower and more expensive than `aws_dynamodb_query_table` — prefer that
when the partition key is known. Paginates internally up to `maxItems`.

Same params as `aws_dynamodb_query_table` minus `keyConditionExpression`/`scanIndexForward`.

**Example call:**

```json
{
  "tableName": "orders",
  "filterExpression": "#s = :status",
  "expressionAttributeNames": {
    "#s": "status"
  },
  "expressionAttributeValues": {
    ":status": "failed"
  },
  "maxItems": 50
}
```

**Example response:**

```json
{
  "items": [
    {
      "orderId": "ord_1120",
      "status": "failed"
    }
  ],
  "truncated": true
}
```

`truncated: true` means more items than `maxItems` still match — narrow the filter or paginate by re-running with a
higher `maxItems` if you need the full set.
