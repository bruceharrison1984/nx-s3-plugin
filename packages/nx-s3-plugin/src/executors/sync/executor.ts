import { BuildExecutorSchema } from './schema';
import { Executor } from '@nrwl/devkit';
import { Presets, SingleBar } from 'cli-progress';
import { S3Client } from '@aws-sdk/client-s3';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { getCloudFormationExportValue } from './cloudformationExportLookup';
import { lookup } from 'mime-types';
import S3SyncClient from 's3-sync-client';
import recursive from 'recursive-readdir';

const runExecutor: Executor<BuildExecutorSchema> = async ({
  sourceFiles,
  bucketName,
  region,
  profile,
  batchSize = 500,
  progress = true,
  deleteFiles = true,
}) => {
  console.log('-= Running S3 Sync Executor =-');
  if (!bucketName || bucketName.trim() === '')
    throw new Error('bucketName is a required argument');

  const fileList = await recursive(sourceFiles);

  if (fileList.length === 0)
    throw new Error(
      'File list contains no files. Please specify a different directory. '
    );

  let bucketUrl: string;
  const matches = bucketName.match(/^cfe:(.*)$/);
  if (matches) {
    const cfExportBucket = await getCloudFormationExportValue(
      matches[1],
      region,
      profile
    );
    bucketUrl = `s3://${cfExportBucket.trim()}`;
  } else {
    bucketUrl = `s3://${bucketName.trim()}`;
  }

  console.log(`
  ${
    matches
      ? `- CF Export Lookup: ${matches[1]}`
      : `- Bucket Name: ${bucketName}`
  }
  - Source directory: ${sourceFiles}
  - Total files: ${fileList.length}
  - S3 Url: ${bucketUrl}
  - Batch size: ${batchSize}
  - Deletion: ${deleteFiles ? 'ENABLED' : 'DISABLED'}
  - AWS profile: ${profile ? profile : 'DEFAULT'}
  - AWS region: ${region ? region : 'DEFAULT'}
  `);

  const s3Client = new S3Client({
    region,
    credentials: profile ? defaultProvider({ profile }) : undefined,
  });
  const { sync } = new S3SyncClient({ client: s3Client });
  const monitor = new S3SyncClient.TransferMonitor();

  const progressBar = new SingleBar(
    { noTTYOutput: true, stream: process.stdout },
    Presets.shades_classic
  );

  if (progress) {
    let progressStarted = false;
    monitor.on('progress', ({ count }) => {
      if (count.current % Math.ceil(count.total / 100) > 0) return;

      if (!progressStarted) {
        progressBar.start(count.total, 0);
        progressStarted = true;
      }
      progressBar.update(count.current);
    });
  }

  let results;
  try {
    results = await sync(sourceFiles, bucketUrl, {
      del: deleteFiles,
      monitor,
      maxConcurrentTransfers: batchSize,
      commandInput: {
        ContentType: (syncCommandInput) => lookup(syncCommandInput.Key) || '',
      },
    });
  } finally {
    progressBar.stop();
    s3Client.destroy();
  }

  console.log(' ');
  console.log(`
-= S3 Sync Results =-
  - Uploads: ${results.uploads.length}
  - Deletions: ${results.deletions.length}
  `);

  return {
    success: true,
  };
};

export default runExecutor;
