import "server-only";
import { AwsClient } from "aws4fetch";
import { R2 } from "./config";

/** Cloudflare R2 through its S3 API (aws4fetch: SigV4 without the AWS SDK). */
const client = () =>
  new AwsClient({
    accessKeyId: R2.accessKeyId,
    secretAccessKey: R2.secretAccessKey,
    service: "s3",
    region: "auto",
  });

const objectUrl = (key: string) =>
  `https://${R2.accountId}.r2.cloudflarestorage.com/${R2.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;

/** URL the browser can PUT the file to directly, valid for `expires` seconds. */
export async function presignPut(key: string, contentType: string, expires = 600): Promise<string> {
  const url = new URL(objectUrl(key));
  url.searchParams.set("X-Amz-Expires", String(expires));
  const signed = await client().sign(new Request(url, { method: "PUT", headers: { "Content-Type": contentType } }), {
    aws: { signQuery: true },
  });
  return signed.url;
}

export async function deleteObject(key: string): Promise<void> {
  await client().fetch(objectUrl(key), { method: "DELETE" });
}
