import { AzureFunction, Context, HttpRequest } from "@azure/functions";
import S3 from "aws-sdk/clients/s3";
import { ok, err, Result } from "neverthrow";
import * as AWS from "aws-sdk/global";
import fs from "fs";

const S3_CLIENT = new S3({
    region: "us-west-2",
    params: { Bucket: process.env.S3_BUCKET },
    endpoint: process.env.AWS_S3_ENDPOINT || undefined,
    sslEnabled: !process.env.AWS_S3_ENDPOINT,
    s3ForcePathStyle: true,
});
const BASIC_AUTH_HEADER =
    "Basic " +
    Buffer.from(
        process.env.HTTP_BASIC_AUTH_USER +
            ":" +
            process.env.HTTP_BASIC_AUTH_PASS
    ).toString("base64");

const httpTrigger: AzureFunction = async function (
    context: Context,
    req: HttpRequest
): Promise<void> {
    context.log("App is processing request:");
    context.log(req);
    if (
        !req.headers.authorization ||
        req.headers.authorization !== BASIC_AUTH_HEADER
    ) {
        context.res = {
            status: 401,
            body: "Incorrect HTTP Auth\n",
        };
        return;
    }
    let parseres = parseOp(req);
    if (parseres.isErr()) {
        switch (parseres.error) {
            case ParseFailure.UnsupportedMethod:
                context.res = {
                    status: 405,
                    body: "Method not allowed." + req.method + "\n",
                };
                return;
            case ParseFailure.MalformedDestHeader:
                context.res = {
                    status: 400,
                    body: "Destination header malformed or missing.\n",
                };
                return;
        }
    }
    let op = parseres.value;
    try {
        let s3resp = await performS3Operation(op);
        let tfres = AwsToFunctionHttpResp(s3resp);
        console.log(tfres);
        context.res = tfres;
        return;
    } catch (e) {
        context.log("Error from S3:");
        context.log(e);
        context.res = {
            status: 500,
            body: "Internal error with S3.\n",
        };
        return;
    }
};

enum ParseFailure {
    UnsupportedMethod,
    MalformedDestHeader,
}

function parseOp(req: HttpRequest): Result<Operation, ParseFailure> {
    // As any is necessary because the ts type is a union, not a string
    // Meaning custom verbs aren't type-safe (no MOVE)
    switch (req.method as any) {
        case "GET":
            return ok({ verb: "GET", key: req.params.filename });
        case "DELETE":
            return ok({ verb: "DELETE", key: req.params.filename });
        case "PUT":
            fs.writeFileSync("PUTFILEBODY", req.body);
            fs.writeFileSync("PUTFILERAWBODY", req.rawBody);
            return ok({
                verb: "PUT",
                key: req.params.filename,
                body: req.body,
            });
        case "MOVE":
            let moveDest = computeDestS3Key(
                req.headers.destination,
                // any for undocumented attribute
                (req as any).originalUrl
            );
            if (!moveDest) {
                return err(ParseFailure.MalformedDestHeader);
            }
            return ok({
                verb: "MOVE",
                from: req.params.filename,
                to: moveDest,
            });
        default:
            return err(ParseFailure.UnsupportedMethod);
    }
}

function getSuccessCode(op: Operation): number {
    switch (op.verb) {
        case "GET":
        case "DELETE":
        case "PUT":
            return 200;
        case "MOVE":
            return 201;
        default:
            let never: never = op;
            return never;
    }
}

interface GetOp {
    verb: "GET";
    key: string;
}
interface DeleteOp {
    verb: "DELETE";
    key: string;
}
interface PutOp {
    verb: "PUT";
    key: string;
    body: any;
}
interface MoveOp {
    verb: "MOVE";
    from: string;
    to: string;
}
type Operation = GetOp | DeleteOp | PutOp | MoveOp;

const computeDestS3Key = function (
    destHeader: string,
    originalUrl: string
): string | null {
    if (!destHeader) {
        return null;
    }
    // this method works because the namespace is flat, there are no folder terms to worry about
    let split = destHeader.split("/");
    let key: string = split[split.length - 1];

    // check that our method is sane via the original url:
    let origSplit = originalUrl.split("/");
    let origBase = origSplit.slice(0, origSplit.length - 1).join("/");
    if (origBase + "/" + key !== destHeader) {
        console.log({
            message: "Error when verifying destination header parsing.",
            expected: destHeader,
            actual: origBase + key,
        });
        return null;
    }
    return key;
};

async function rawS3ResponsePromise<D, E>(
    req: AWS.Request<D, E>
): Promise<AWS.HttpResponse> {
    return new Promise((resolve, _reject) => {
        req.on("complete", (response) => {
            resolve(response.httpResponse);
        });
        req.send();
    });
}

interface HttpResponseLike {
    statusCode: number;
    body: string | Buffer | Uint8Array;
    headers?: { [key: string]: string };
}
interface AzureFuncHttpResponse {
    status: number;
    headers?: { [key: string]: string };
    body: any;
    isRaw?: boolean;
}

function AwsToFunctionHttpResp(resp: HttpResponseLike): AzureFuncHttpResponse {
    return {
        status: resp.statusCode,
        headers: resp.headers,
        body: resp.body,
        isRaw: true,
    };
}

const performS3Operation = async function (
    op: Operation
): Promise<HttpResponseLike> {
    switch (op.verb) {
        case "GET":
            return await rawS3ResponsePromise(
                S3_CLIENT.getObject({ Key: op.key } as any)
            );
        case "DELETE":
            return await rawS3ResponsePromise(
                S3_CLIENT.deleteObject({
                    Key: op.key,
                } as any)
            );
        case "PUT":
            return await rawS3ResponsePromise(
                S3_CLIENT.putObject({
                    Key: op.key,
                    Body: op.body,
                } as any)
            );
        case "MOVE":
            // cop-out here:
            // instead of passing along errors like with other calls
            // (eg a 404 for missing key), we just let the S3 client catch them
            // and pass every error off as a 500 in the outer function.
            let _copyResult = await S3_CLIENT.copyObject({
                Key: op.to,
                CopySource: encodeURIComponent(
                    process.env.S3_BUCKET + "/" + op.from
                ),
            } as any).promise();
            let _deleteResult = await S3_CLIENT.deleteObject({
                Key: op.from,
            } as any).promise();
            return {
                statusCode: 201,
                body: "",
            };
        default:
            let never: never = op;
            return never;
    }
};

export default httpTrigger;

// TODO: debug move issue
