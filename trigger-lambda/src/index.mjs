// Trigger Lambda — receives SNS from CloudWatch Alarm, invokes Bedrock Agent.
// Reports findings to Slack with professional formatting.
// First responder only — investigates and reports, does NOT execute fixes.

import { BedrockAgentRuntimeClient, InvokeAgentCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

const AGENT_ID = process.env.BEDROCK_AGENT_ID;
const ALIAS_ID = process.env.BEDROCK_AGENT_ALIAS_ID;
const TABLE = process.env.INVESTIGATION_TABLE || 'nightwatch-investigations';
const SLACK_URL = process.env.SLACK_WEBHOOK_URL || '';
const REGION = process.env.AWS_REGION || 'us-east-1';

const bedrock = new BedrockAgentRuntimeClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });

export const handler = async (event) => {
  console.log('Trigger event:', JSON.stringify(event));

  // Parse SNS message (CloudWatch Alarm)
  const snsMessage = event.Records?.[0]?.Sns?.Message;
  if (!snsMessage) {
    console.log('No SNS message, skipping');
    return { statusCode: 200 };
  }

  let alarm;
  try {
    alarm = JSON.parse(snsMessage);
  } catch {
    console.error('Failed to parse alarm:', snsMessage);
    return { statusCode: 400 };
  }

  // Only act on ALARM state
  if (alarm.NewStateValue !== 'ALARM') {
    console.log(`State is ${alarm.NewStateValue}, skipping`);
    return { statusCode: 200 };
  }

  const alarmName = alarm.AlarmName || 'unknown';
  const reason = alarm.NewStateReason || '';
  const alarmTime = alarm.StateChangeTime || new Date().toISOString();
  const sessionId = `nightwatch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = new Date().toISOString();

  console.log(`Alarm: ${alarmName}, session: ${sessionId}`);

  // Record investigation start
  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: sessionId },
      alarm_name: { S: alarmName },
      started_at: { S: startedAt },
      status: { S: 'INVESTIGATING' },
    },
  }));

  // ── Slack: Alarm fired ────────────────────────────────────
  await slackBlocks([
    { type: 'header', text: { type: 'plain_text', text: '🚨 Incident Detected' } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Service*\ncheckout-service` },
        { type: 'mrkdwn', text: `*Alarm*\n${alarmName}` },
        { type: 'mrkdwn', text: `*Status*\nALARM` },
        { type: 'mrkdwn', text: `*Time*\n${startedAt.split('T')[1].split('.')[0]} UTC` },
      ],
    },
    { type: 'divider' },
    { type: 'context', elements: [{ type: 'mrkdwn', text: '🤖 Nightwatch agent auto-investigating...' }] },
  ]);

  try {
    // ── Invoke Bedrock Agent ────────────────────────────────
    const response = await bedrock.send(new InvokeAgentCommand({
      agentId: AGENT_ID,
      agentAliasId: ALIAS_ID,
      sessionId,
      inputText:
        `CloudWatch alarm "${alarmName}" fired at ${alarmTime} for checkout-service. ` +
        `Reason: ${reason.slice(0, 200)}. ` +
        `IMPORTANT: The incident may have already resolved. Investigate what happened AT THE ALARM TIME. ` +
        `When calling get_error_logs, pass alarm_time="${alarmTime}" so it queries logs around the alarm time, not current time. ` +
        `When calling get_metrics, pass alarm_time="${alarmTime}" so it queries metrics around the alarm time. ` +
        `Call get_service_health, get_metrics (with alarm_time), get_error_logs (with alarm_time), and get_recent_deploys. ` +
        `Even if the service is healthy NOW, report what caused the alarm. The error logs and metrics from the alarm window will show the actual problem. ` +
        `Present your findings: root cause, confidence, evidence, and recommended action. ` +
        `Do NOT execute any remediation. Report only. Call each tool only once.`,
      enableTrace: false,
    }));

    // Collect response
    let findings = '';
    for await (const event of response.completion) {
      if (event.chunk?.bytes) {
        findings += Buffer.from(event.chunk.bytes).toString('utf-8');
      }
    }

    const completedAt = new Date().toISOString();
    const mttrSeconds = Math.floor((new Date(completedAt) - new Date(startedAt)) / 1000);

    console.log('Findings:', findings.slice(0, 500));

    // Update DynamoDB
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk: { S: sessionId } },
      UpdateExpression: 'SET #s = :s, findings = :f, completed_at = :t, mttr_seconds = :m',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s': { S: 'COMPLETED' },
        ':f': { S: findings.slice(0, 4000) },
        ':t': { S: completedAt },
        ':m': { N: String(mttrSeconds) },
      },
    }));

    // ── Slack: Send agent's formatted report directly ──────
    // The agent already produces a clean 7-section template — send it as-is
    const cleanFindings = findings
      .replace(/\*\*/g, '')           // remove markdown bold
      .replace(/^#{1,6}\s+/gm, '')   // remove markdown headers
      .slice(0, 2800);

    await slackBlocks([
      { type: 'header', text: { type: 'plain_text', text: '🎯 Investigation Complete' } },
      { type: 'section', text: { type: 'mrkdwn', text: cleanFindings } },
      { type: 'divider' },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `⏱ Investigation time: ${mttrSeconds}s | 🤖 First responder — no remediation executed` }] },
    ]);

    return { statusCode: 200 };

  } catch (err) {
    console.error('Agent failed:', err);

    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk: { S: sessionId } },
      UpdateExpression: 'SET #s = :s, error_message = :e',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s': { S: 'FAILED' },
        ':e': { S: err.message },
      },
    }));

    await slackBlocks([
      { type: 'header', text: { type: 'plain_text', text: '❌ Investigation Failed' } },
      { type: 'section', text: { type: 'mrkdwn', text: `Error: ${err.message}` } },
    ]);

    return { statusCode: 500 };
  }
};

// ── Parse AI findings into structured sections ──────────────
function parseFindings(text) {
  const result = { rootCause: '', confidence: '', evidence: [], recommendation: '' };
  if (!text) return result;

  const lines = text.split('\n');
  let currentSection = '';

  for (const line of lines) {
    const lower = line.toLowerCase().trim();
    const clean = line.replace(/^[*#\-\s]+/, '').replace(/\*\*/g, '').trim();
    if (!clean) continue;

    if (lower.startsWith('root cause') || lower.includes('root cause:')) {
      currentSection = 'rootCause';
      const val = clean.replace(/^root\s*cause[:\s]*/i, '').trim();
      if (val) result.rootCause = val;
    } else if (lower.startsWith('confidence') || lower.includes('confidence:')) {
      currentSection = 'confidence';
      const val = clean.replace(/^confidence[:\s]*/i, '').trim();
      if (val) result.confidence = val;
    } else if (lower.startsWith('evidence') || lower.includes('evidence:')) {
      currentSection = 'evidence';
    } else if (lower.startsWith('recommend') || lower.startsWith('proposed') || lower.includes('action:')) {
      currentSection = 'recommendation';
      const val = clean.replace(/^(recommended?\s*(action|fix)?|proposed\s*(fix|action)?)[:\s]*/i, '').trim();
      if (val) result.recommendation = val;
    } else if (currentSection === 'rootCause' && !result.rootCause) {
      result.rootCause = clean;
    } else if (currentSection === 'evidence') {
      result.evidence.push(clean);
    } else if (currentSection === 'recommendation' && !result.recommendation) {
      result.recommendation = clean;
    }
  }

  // Fallback: if parsing found nothing, use first 500 chars
  if (!result.rootCause && !result.evidence.length) {
    result.rootCause = text.slice(0, 500);
  }

  // Cap evidence to 5 items for Slack readability
  result.evidence = result.evidence.slice(0, 5);

  return result;
}

// ── Slack Block Kit sender ──────────────────────────────────
async function slackBlocks(blocks) {
  if (!SLACK_URL) return;
  try {
    await fetch(SLACK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blocks }),
    });
  } catch (err) {
    console.warn('Slack failed:', err.message);
  }
}
