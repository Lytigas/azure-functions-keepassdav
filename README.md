# Azure Functions KeepassDav

An Azure function that implements the subset of WebDav needed to synchronize and backup Keepass databases. Stores data in S3.

## Why

I want to backup my password databases and synchronize them painlessly regardless of what OS I'm on. Most Keepass synchronization plugins haven't been updated in years, so I decided to use the WebDav functionality built into Keepass2.

I also don't currently use anything like Dropbox, Syncthing, or Drive sync which are probably the easier way to do this. I don't use those because:

- Drive and Dropbox lack good Linux support and install workflows.
- Syncthing reliability requires either a VPS, which I don't want to pay for, or a server at home accessible from the internet, which I don't have.

With student loans on my horizon, I don't want to pay \$5 a month for a VPS to serve 1 request/day, so FaaS it is.

### Why Not AWS Lambda

To expose an AWS Lambda function to TCP/IP for HTTP, you need to use an AWS API Gateway, which only supports a set of whitelisted HTTP verbs. Keepass uses the WebDav MOVE verb, which is not on that whitelist.

Also, I was pleasantly surprised at how painless the Azure functions development experience is. Unlike with Lambda, there's an officially supported local testing method that doesn't require a mountain of YAML, and "Function Apps" are given a free HTTPS URL by default.

### Why S3

I use it already and didn't want to figure out the Azure equivalent of IAM roles.

### Why Python

I originally wrote this in Typescript, which was nice. The VSCode and S3 story in Typescript is better than that in Python, mostly because of the typing. Unfortunately, this app sends binary files over HTTP, and the Azure Functions runtime for Node handles binary data in a less than desirable way. Unless the `Content-Type: application/octet-stream` header is present, the runtime assumes the data is UTF-8, and happily inserts/overwrites `U+FFFD` characters (`0xEF 0xBF 0xBD`) into your data. Yep, even for other MIME-types that are obviously binary data. Yep, even if you explicitly tell the runtime `"dataType": "binary"`. Yep, even if you use the `rawBody` property instead of `body`. Of course, Keepass doesn't send the requisite MIME-type header.

There's an [open issue](https://github.com/Azure/azure-functions-host/issues/4475) for this, and thankfully the runtime is open source so I could quickly understand the issue. However, the lack of progress in a year convinced me to just rewrite the app.

## How Much This Costs

I have a couple hundred entries in my .kdbx, and it's 33K. Azure Functions has a free allocation that should cover any individual's use. I store the data in an S3 bucket with versioning on. Let's overestimate. After 5 saves per day at 50KB each for 5 years the monthly charge will be:

```txt
5 * 365 * 5 * 2 * 50 * 0.025 / 1000 / 1000 = $0.0228125
```

The extra factor of two accounts for Keepass saving to a temporary file and then MOVE-ing it to the correct location. Since you can't version only one object in S3, you have to the cost of those versions.

The total cost of 5 years of API calls will be around:

```txt
5 * 365 * 5 * 6 * 0.005 / 1000 = $0.27375
```

Interesting tidbit: The data is so small that the cost of a lifecycle rule to migrate old versions to the Standard IA tier is actually more than paying the higher storage cost for 24 months. Also, Standard IA charges at least 128KB per object, which costs more than 33KB at the Standard tier.

I suppose in 2 years I might write a batch job that puts old versions into a tar archive and uploads them as one Standard IA object to save on storage costs.

## Automatic Backup

Keepass2 has built-in [trigger](https://keepass.info/help/v2/triggers.html) functionality that I use to synchronize the database to S3 on save. Since S3 versioning is on, this also creates a persistent backup. I store the URL and HTTP basic authentication credentials in the Keepass database and extract them using [field references](https://keepass.info/help/base/fieldrefs.html). If you write your own sync-on-save trigger, be careful of [infinite loops](https://keepass.info/help/kb/trigger_examples.html#infiniteloop). A copy of mine is in [`sync-on-save.keepasstrigger.xml`](sync-on-save.keepasstrigger.xml).
