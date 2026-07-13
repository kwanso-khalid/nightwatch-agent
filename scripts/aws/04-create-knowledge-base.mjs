// Phase A3: Create S3 bucket, upload KB docs, create Bedrock Knowledge Base,
// sync, and associate with the agent.
// Run: node scripts/aws/04-create-knowledge-base.mjs
//
// Reads BEDROCK_AGENT_ID from .env.demo.
// Writes KB_ID, KB_S3_BUCKET, KB_DATA_SOURCE_ID back to .env.demo.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ENV_FILE = path.join(ROOT, '.env.demo');
const KB_DIR = path.join(ROOT, 'docs/kb');

// Load .env.demo
const envRaw = fs.readFileSync(ENV_FILE, 'utf8');
const env = {};
for (const line of envRaw.split('\n')) {
  if (line.startsWith('#') || !line.includes('=')) continue;
  const [k, ...v] = line.split('=');
  env[k.trim()] = v.join('=').trim();
}

const AGENT_ID = env.BEDROCK_AGENT_ID;
const REGION = env.AWS_REGION || 'us-east-1';
const ACCOUNT = (await import('child_process')).execSync(
  'aws sts get-caller-identity --query Account --output text --region us-east-1'
).toString().trim();

const BUCKET_NAME = `nightwatch-kb-${ACCOUNT}-${REGION}`;
const KB_NAME = 'nightwatch-knowledge-base';

async function run() {
  const { S3Client, CreateBucketCommand, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { BedrockAgentClient, CreateKnowledgeBaseCommand, CreateDataSourceCommand,
    StartIngestionJobCommand, AssociateAgentKnowledgeBaseCommand, PrepareAgentCommand,
    GetIngestionJobCommand } = await import('@aws-sdk/client-bedrock-agent');

  const s3 = new S3Client({ region: REGION });
  const agent = new BedrockAgentClient({ region: REGION });

  // 1. Create S3 bucket
  console.log(`Creating S3 bucket: ${BUCKET_NAME}...`);
  try {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET_NAME }));
    console.log('  Created.');
  } catch (e) {
    if (e.name === 'BucketAlreadyOwnedByYou') console.log('  Already exists (owned by you).');
    else throw e;
  }

  // 2. Upload KB docs
  console.log('Uploading KB docs...');
  for (const subdir of ['runbooks', 'postmortems']) {
    const dir = path.join(KB_DIR, subdir);
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const key = `${subdir}/${file}`;
      const body = fs.readFileSync(path.join(dir, file));
      await s3.send(new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, Body: body, ContentType: 'text/markdown' }));
      console.log(`  Uploaded: ${key}`);
    }
  }

  // 3. Create Knowledge Base
  console.log(`\nCreating Knowledge Base: ${KB_NAME}...`);
  // The KB needs an execution role. Try to use an existing one or instruct the user.
  const KB_ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/AmazonBedrockExecutionRoleForKnowledgeBase_nightwatch`;

  let kbId;
  try {
    const kbResult = await agent.send(new CreateKnowledgeBaseCommand({
      name: KB_NAME,
      description: 'Past incident postmortems and runbooks for checkout-service.',
      roleArn: KB_ROLE_ARN,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${REGION}::foundation-model/amazon.titan-embed-text-v2:0`,
        },
      },
      storageConfiguration: {
        type: 'OPENSEARCH_SERVERLESS',
        opensearchServerlessConfiguration: {
          collectionArn: '', // Will be created by quick-create
          vectorIndexName: 'nightwatch-kb-index',
          fieldMapping: {
            vectorField: 'vector',
            textField: 'text',
            metadataField: 'metadata',
          },
        },
      },
    }));
    kbId = kbResult.knowledgeBase.knowledgeBaseId;
    console.log(`  Created: ${kbId}`);
  } catch (e) {
    console.error(`\n  ERROR creating Knowledge Base: ${e.message}`);
    console.log(`\n  This likely means you need to create the KB manually in the console:`);
    console.log(`  1. Go to: AWS Console > Bedrock > Knowledge Bases > Create`);
    console.log(`  2. Name: ${KB_NAME}`);
    console.log(`  3. Data source: S3, bucket: ${BUCKET_NAME}`);
    console.log(`  4. Embedding model: Titan Text Embeddings v2`);
    console.log(`  5. Vector store: Quick create (OpenSearch Serverless)`);
    console.log(`  6. After creation, note the KB ID and add to .env.demo as KB_ID=<id>`);
    console.log(`  7. Then run: node scripts/aws/05-associate-kb.mjs`);
    process.exit(1);
  }

  // 4. Create data source
  console.log('Creating data source...');
  const dsResult = await agent.send(new CreateDataSourceCommand({
    knowledgeBaseId: kbId,
    name: 'nightwatch-kb-docs',
    dataSourceConfiguration: {
      type: 'S3',
      s3Configuration: {
        bucketArn: `arn:aws:s3:::${BUCKET_NAME}`,
      },
    },
  }));
  const dsId = dsResult.dataSource.dataSourceId;
  console.log(`  Data source: ${dsId}`);

  // 5. Sync (ingest)
  console.log('Starting ingestion job...');
  const jobResult = await agent.send(new StartIngestionJobCommand({
    knowledgeBaseId: kbId,
    dataSourceId: dsId,
  }));
  const jobId = jobResult.ingestionJob.ingestionJobId;
  console.log(`  Job: ${jobId}`);

  // Wait for sync
  console.log('Waiting for sync to complete...');
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const status = await agent.send(new GetIngestionJobCommand({
      knowledgeBaseId: kbId, dataSourceId: dsId, ingestionJobId: jobId,
    }));
    const s = status.ingestionJob.status;
    if (s === 'COMPLETE') { console.log('  Sync complete.'); break; }
    if (s === 'FAILED') { console.error('  Sync FAILED:', status.ingestionJob.failureReasons); break; }
    console.log(`  Status: ${s}...`);
  }

  // 6. Associate with agent
  if (AGENT_ID) {
    console.log(`Associating KB with agent ${AGENT_ID}...`);
    await agent.send(new AssociateAgentKnowledgeBaseCommand({
      agentId: AGENT_ID,
      agentVersion: 'DRAFT',
      knowledgeBaseId: kbId,
      description: 'Past incident postmortems and runbooks for checkout-service. Search for matching incidents by error signature, metric pattern, or service name.',
      knowledgeBaseState: 'ENABLED',
    }));
    console.log('  Associated.');

    // Re-prepare agent
    console.log('Re-preparing agent...');
    await agent.send(new PrepareAgentCommand({ agentId: AGENT_ID }));
    console.log('  Done.');
  }

  // 7. Save to .env.demo
  const additions = `\n# Knowledge Base (created by 04-create-knowledge-base.mjs)\nKB_ID=${kbId}\nKB_S3_BUCKET=${BUCKET_NAME}\nKB_DATA_SOURCE_ID=${dsId}\n`;
  fs.appendFileSync(ENV_FILE, additions);

  console.log(`\nDone. KB ID: ${kbId}`);
  console.log('Saved to .env.demo');
}

run().catch((err) => { console.error('FATAL:', err); process.exit(1); });
