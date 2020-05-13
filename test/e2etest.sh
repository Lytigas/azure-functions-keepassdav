#!/usr/bin/env bash

set -euxo pipefail

export URL="http://localhost:7071/dav"
export API="http://user:pass@localhost:7071/dav"
export FILE="testfile.bin"

curl -D - --upload-file $FILE $API/file

echo "Compare:"
sha256sum $FILE
curl $API/file | sha256sum

# curl -X DELETE $API/file
# curl $API/file


curl -X MOVE --header "Destination: $URL/file2" $API/file
curl $API/file2 | sha256sum


# aws --endpoint-url=http://localhost:4572 s3api copy-object --bucket flatdav-test-bucket --copy-source file --key file2
