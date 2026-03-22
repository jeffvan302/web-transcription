import fs from "node:fs";
import path from "node:path";
import { HeadBucketCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getStorageSettings } from "./database.js";
import { ensureDir, joinObjectKey } from "./helpers.js";
import { paths } from "./config.js";

function resolveLocalObjectPath(key) {
  return path.join(paths.storageDir, ...String(key).split("/"));
}

function createS3Client(settings) {
  return new S3Client({
    region: settings.region,
    endpoint: settings.endpointUrl || undefined,
    forcePathStyle: settings.addressingMode === "path",
    credentials:
      settings.accessKeyId && settings.secretAccessKey
        ? {
            accessKeyId: settings.accessKeyId,
            secretAccessKey: settings.secretAccessKey,
          }
        : undefined,
  });
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))));
}

export function getObjectKey(...parts) {
  const settings = getStorageSettings(false);
  return joinObjectKey(settings.prefix, ...parts);
}

export function getStorageService() {
  const settings = getStorageSettings(true);

  if (settings.provider === "Local Disk") {
    return {
      mode: "local",
      settings,
      async putBuffer(key, buffer) {
        const targetPath = resolveLocalObjectPath(key);
        ensureDir(path.dirname(targetPath));
        await fs.promises.writeFile(targetPath, buffer);
      },
      async putFile(key, filePath) {
        const targetPath = resolveLocalObjectPath(key);
        ensureDir(path.dirname(targetPath));
        await fs.promises.copyFile(filePath, targetPath);
      },
      async getBuffer(key) {
        return fs.promises.readFile(resolveLocalObjectPath(key));
      },
      async deleteObject(key) {
        await fs.promises.rm(resolveLocalObjectPath(key), { force: true });
      },
      resolveLocalPath(key) {
        return resolveLocalObjectPath(key);
      },
      async testConnection() {
        ensureDir(paths.storageDir);
        await fs.promises.access(paths.storageDir, fs.constants.R_OK | fs.constants.W_OK);
      },
    };
  }

  const client = createS3Client(settings);

  return {
    mode: "s3",
    settings,
    async putBuffer(key, buffer, contentType = "application/octet-stream") {
      await client.send(
        new PutObjectCommand({
          Bucket: settings.bucket,
          Key: key,
          Body: buffer,
          ContentType: contentType,
        }),
      );
    },
    async putFile(key, filePath, contentType = "application/octet-stream") {
      const upload = new Upload({
        client,
        params: {
          Bucket: settings.bucket,
          Key: key,
          Body: fs.createReadStream(filePath),
          ContentType: contentType,
        },
      });
      await upload.done();
    },
    async getBuffer(key) {
      const response = await client.send(
        new GetObjectCommand({
          Bucket: settings.bucket,
          Key: key,
        }),
      );
      return streamToBuffer(response.Body);
    },
    async deleteObject(key) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: settings.bucket,
          Key: key,
        }),
      );
    },
    resolveLocalPath() {
      return null;
    },
    async testConnection() {
      await client.send(
        new HeadBucketCommand({
          Bucket: settings.bucket,
        }),
      );
    },
  };
}
