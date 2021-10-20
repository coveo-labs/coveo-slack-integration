aws dynamodb create-table ^
  --attribute-definitions ^
    AttributeName=user,AttributeType=S ^
  --key-schema ^
    AttributeName=user,KeyType=HASH ^
  --table-name awsSlackCache ^
  --provisioned-throughput ^
    ReadCapacityUnits=1,WriteCapacityUnits=1 ^