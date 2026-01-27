const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const fs = require('fs');

const s3Client = new S3Client({
    region: "auto",
    endpoint: process.env.S3_ENDPOINT, // https://<ACCOUNT_ID>.r2.cloudflarestorage.com
    credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
});

/**
 * Загрузка буфера в R2
 */
async function uploadToR2(fileBuffer, fileName, mimeType) {
    const upload = new Upload({
        client: s3Client,
        params: {
            Bucket: process.env.S3_BUCKET_NAME,
            Key: `uploads/${fileName}`,
            Body: fileBuffer,
            ContentType: mimeType,
        },
    });
    return upload.done();
}

/**
 * Скачивание из R2 в локальный файл для обработки Python-скриптом
 */
async function downloadFromR2(key, localPath) {
    const command = new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: key,
    });
    const response = await s3Client.send(command);
    const writeStream = fs.createWriteStream(localPath);
    return new Promise((resolve, reject) => {
        response.Body.pipe(writeStream)
            .on('finish', resolve)
            .on('error', reject);
    });
}

module.exports = { uploadToR2, downloadFromR2 };