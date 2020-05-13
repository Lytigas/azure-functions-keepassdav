import azure.functions as func
import logging

import boto3
from botocore.exceptions import ClientError
import os
import base64


S3_CLIENT = boto3.client(
    "s3",
    region_name="us-west-2",
    endpoint_url=os.environ.get("AWS_S3_ENDPOINT"),
    use_ssl=not os.environ.get("AWS_S3_ENDPOINT"),
)
S3_BUCKET = os.environ["S3_BUCKET"]
BASIC_AUTH_HEADER = "Basic " + base64.b64encode(
    (
        os.environ["HTTP_BASIC_AUTH_USER"] + ":" + os.environ["HTTP_BASIC_AUTH_PASS"]
    ).encode("utf-8")
).decode("utf-8")


def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("Python HTTP trigger function processed a request.")
    if req.headers.get("Authorization", "") != BASIC_AUTH_HEADER:
        return func.HttpResponse("Incorrect HTTP Auth\n", status_code=401)

    op = parse_op(req)
    if isinstance(op, func.HttpResponse):
        return op
    try:
        s3resp = do_s3_op(op)
        return s3_to_http(s3resp)
    except ClientError as e:
        logging.info("Error from S3:")
        logging.info(e, exc_info=True)
        response = e.response
        return func.HttpResponse(
            f"Error from S3: {response['Error']['Code']}\n{response['Error']['Message']}\n",
            status_code=response["ResponseMetadata"]["HTTPStatusCode"],
        )


def parse_op(req: func.HttpRequest):
    if req.method == "GET":
        return {"method": req.method, "key": req.route_params["filename"]}
    elif req.method == "DELETE":
        return {"method": req.method, "key": req.route_params["filename"]}
    elif req.method == "PUT":
        return {
            "method": req.method,
            "key": req.route_params["filename"],
            "body": req.get_body(),
        }
    elif req.method == "MOVE":
        movedest = compute_s3_dest_key(req.headers.get("Destination"), req.url)
        if not movedest:
            return func.HttpResponse(status_code=400)
        return {
            "method": req.method,
            "from": req.route_params["filename"],
            "to": movedest,
        }
    else:
        return func.HttpResponse(status_code=405)


def compute_s3_dest_key(dest_header, original_url):
    if not dest_header:
        return None
    # hack cause we're in a flat namespace
    key = dest_header.split("/")[-1]
    # check:
    base = "/".join(original_url.split("/")[:-1])
    if base + "/" + key != dest_header:
        logging.info(
            {
                "message": "Error when verifying destination header parsing.",
                "expected": dest_header,
                "actual": base + "/" + key,
            }
        )
        return None
    return key


def do_s3_op(op):
    if op["method"] == "GET":
        return S3_CLIENT.get_object(Bucket=S3_BUCKET, Key=op["key"])
    elif op["method"] == "DELETE":
        return S3_CLIENT.delete_object(Bucket=S3_BUCKET, Key=op["key"])
    elif op["method"] == "PUT":
        return S3_CLIENT.put_object(Bucket=S3_BUCKET, Key=op["key"], Body=op["body"])
    elif op["method"] == "MOVE":
        copyres = S3_CLIENT.copy_object(
            Bucket=S3_BUCKET, Key=op["to"], CopySource=S3_BUCKET + "/" + op["from"]
        )
        deleteres = S3_CLIENT.delete_object(Bucket=S3_BUCKET, Key=op["from"])
        # Fake an S3-response like for later conversion
        return {"ResponseMetadata": {"HTTPStatusCode": 201,}}
    else:
        raise Exception("Unrechable")


def s3_to_http(s3res) -> func.HttpResponse:
    return func.HttpResponse(
        body=s3res["Body"].read() if "Body" in s3res else None,
        status_code=s3res["ResponseMetadata"]["HTTPStatusCode"],
        # headers are optional, so use .get
        headers=s3res["ResponseMetadata"].get("HTTPHeaders"),
    )
