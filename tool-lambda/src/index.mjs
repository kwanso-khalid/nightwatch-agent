// Tool Lambda — reads real CloudWatch/ECS for Bedrock Agent action groups.
// Token-optimized: returns summaries, not raw data.

import { ECSClient, DescribeServicesCommand, ListTasksCommand, DescribeTasksCommand, ListTaskDefinitionsCommand, DescribeTaskDefinitionCommand } from '@aws-sdk/client-ecs';
import { CloudWatchClient, GetMetricDataCommand, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand } from '@aws-sdk/client-cloudwatch-logs';

const CLUSTER = process.env.CLUSTER_NAME || 'nightwatch-cluster';
const SERVICE = process.env.SERVICE_NAME || 'checkout-service';
const LOG_GROUP = process.env.LOG_GROUP_NAME || '/ecs/nightwatch-checkout';
const REGION = process.env.AWS_REGION || 'us-east-1';

const ecs = new ECSClient({ region: REGION });
const cw = new CloudWatchClient({ region: REGION });
const cwl = new CloudWatchLogsClient({ region: REGION });

export const handler = async (event) => {
  // Route: Bedrock Action Group or direct invoke
  let action, params = {};

  if (event?.messageVersion && event?.actionGroup) {
    action = event.function;
    for (const p of event.parameters || []) params[p.name] = p.value;
  } else {
    action = event.action;
    params = event;
  }

  let body;
  try {
    switch (action) {
      case 'get_service_health': body = await getServiceHealth(); break;
      case 'get_metrics': body = await getMetrics(params); break;
      case 'get_error_logs': body = await getErrorLogs(params); break;
      case 'get_recent_deploys': body = await getRecentDeploys(params); break;
      default: body = { error: `Unknown action: ${action}` };
    }
  } catch (err) {
    console.error(`Tool error (${action}):`, err);
    body = { error: err.message };
  }

  if (event?.messageVersion) {
    return {
      messageVersion: '1.0',
      response: {
        actionGroup: event.actionGroup,
        function: event.function,
        functionResponse: { responseBody: { TEXT: { body: JSON.stringify(body) } } },
      },
      sessionAttributes: event.sessionAttributes || {},
      promptSessionAttributes: event.promptSessionAttributes || {},
    };
  }
  return body;
};

// ── get_service_health ──────────────────────────────────────
async function getServiceHealth() {
  const [svcResp, alarmResp] = await Promise.all([
    ecs.send(new DescribeServicesCommand({ cluster: CLUSTER, services: [SERVICE] })),
    cw.send(new DescribeAlarmsCommand({ AlarmNamePrefix: 'nightwatch-' })),
  ]);

  const svc = svcResp.services?.[0];
  const alarms = (alarmResp.MetricAlarms || []).map(a => ({
    name: a.AlarmName,
    state: a.StateValue,
  }));

  const isDegraded = alarms.some(a => a.state === 'ALARM');

  return {
    service: SERVICE,
    status: isDegraded ? 'DEGRADED' : 'HEALTHY',
    running_tasks: `${svc?.runningCount || 0}/${svc?.desiredCount || 0}`,
    current_task_definition: svc?.taskDefinition?.split('/').pop(),
    alarms,
  };
}

// ── get_metrics (with baseline comparison) ──────────────────
async function getMetrics(params) {
  const minutesBack = Number(params.minutes_back) || 15;
  let end;
  if (params.alarm_time) {
    end = new Date(new Date(params.alarm_time).getTime() + 180000);
  } else {
    end = new Date();
  }
  const start = new Date(end - minutesBack * 60000);

  // Also fetch 6-hour baseline for comparison (longer = more stable average, but 6h keeps it recent)
  const baselineStart = new Date(end - 6 * 3600000);
  const baselineEnd = new Date(start); // baseline ends where incident window starts

  const ecsDims = [{ Name: 'ClusterName', Value: CLUSTER }, { Name: 'ServiceName', Value: SERVICE }];
  const metricDefs = [
    { id: 'error_count', baseId: 'error_count_baseline', namespace: 'Nightwatch/CheckoutService', name: 'ErrorCount', stat: 'Sum', label: 'Error count per minute' },
    { id: 'cpu', baseId: 'cpu_baseline', namespace: 'AWS/ECS', name: 'CPUUtilization', stat: 'Average', dimensions: ecsDims, label: 'CPU %' },
    { id: 'memory', baseId: 'memory_baseline', namespace: 'AWS/ECS', name: 'MemoryUtilization', stat: 'Average', dimensions: ecsDims, label: 'Memory %' },
  ];

  // Build queries: incident window (1-min period) + baseline window (1-hour period for avg)
  const queries = [];
  for (const m of metricDefs) {
    // Incident window
    queries.push({
      Id: m.id,
      MetricStat: {
        Metric: { Namespace: m.namespace, MetricName: m.name, Dimensions: m.dimensions },
        Period: 60, Stat: m.stat,
      },
    });
    // Baseline (6-hour average in 1-hour buckets)
    queries.push({
      Id: m.baseId,
      MetricStat: {
        Metric: { Namespace: m.namespace, MetricName: m.name, Dimensions: m.dimensions },
        Period: 3600, Stat: 'Average',
      },
    });
  }

  const resp = await cw.send(new GetMetricDataCommand({
    StartTime: baselineStart,
    EndTime: end,
    MetricDataQueries: queries,
  }));

  const metricContext = {
    error_count: { unit: 'errors/min', note: 'Total ERROR log entries per minute' },
    cpu: { unit: '% of vCPU allocation', note: 'Container has 0.25 vCPU (256 units).' },
    memory: { unit: '% of memory limit', note: 'Container has 512MB limit.' },
  };

  // Build results map
  const rawResults = {};
  for (const result of resp.MetricDataResults || []) {
    rawResults[result.Id] = { values: result.Values || [], timestamps: result.Timestamps || [] };
  }

  const metrics = {};
  for (const m of metricDefs) {
    const incident = rawResults[m.id] || { values: [], timestamps: [] };
    const baseline = rawResults[m.baseId] || { values: [], timestamps: [] };
    const ctx = metricContext[m.id] || {};

    // Filter incident values to only the incident window
    const incidentValues = [];
    const incidentTimestamps = [];
    for (let i = 0; i < incident.values.length; i++) {
      const t = incident.timestamps[i];
      if (t >= start && t <= end) {
        incidentValues.push(incident.values[i]);
        incidentTimestamps.push(t);
      }
    }

    // Calculate baseline average from pre-incident period
    const baselineValues = baseline.values.filter((_, i) => baseline.timestamps[i] < start);
    const baselineAvg = baselineValues.length > 0
      ? baselineValues.reduce((s, v) => s + v, 0) / baselineValues.length
      : null;

    const current = incidentValues[0] ?? null;
    const peak = incidentValues.length ? Math.max(...incidentValues) : null;

    // Calculate deviation as simple multiplier (e.g., "30x above baseline")
    let multiplier = null;
    let deviationText = 'no baseline data';
    if (baselineAvg != null && current != null) {
      if (baselineAvg > 0) {
        multiplier = Math.round((current / baselineAvg) * 10) / 10;
        if (multiplier >= 2) deviationText = `${multiplier}x above baseline`;
        else if (multiplier <= 0.5) deviationText = `${multiplier}x below baseline`;
        else deviationText = 'within normal range';
      } else if (current > 0) {
        deviationText = 'above baseline (baseline was 0)';
      } else {
        deviationText = 'at baseline';
      }
    }

    metrics[m.id] = {
      label: m.label,
      unit: ctx.unit || '%',
      note: ctx.note || '',
      current: current != null ? Math.round(current * 100) / 100 : null,
      peak: peak != null ? Math.round(peak * 100) / 100 : null,
      baseline_6h_avg: baselineAvg != null ? Math.round(baselineAvg * 100) / 100 : null,
      deviation: deviationText,
      status: multiplier == null ? 'unknown'
        : m.id === 'error_count' ? (current > 5 ? 'ELEVATED' : 'NORMAL')
        : multiplier > 1.5 ? 'ELEVATED' : 'NORMAL',
      points: incidentValues.length,
      datapoints: incidentValues.slice(0, 10).map((v, i) => ({
        time: incidentTimestamps[i]?.toISOString()?.split('.')[0] || '',
        value: Math.round(v * 100) / 100,
      })),
    };
  }

  return { service: SERVICE, window_minutes: minutesBack, metrics };
}

// ── get_error_logs (CloudWatch Logs Insights — aggregated) ──
async function getErrorLogs(params) {
  const minutesBack = Number(params.minutes_back) || 5;
  // If alarm_time is provided, center the window around it (not "now")
  let end, start;
  if (params.alarm_time) {
    const alarmEpoch = Math.floor(new Date(params.alarm_time).getTime() / 1000);
    // Window: 2 minutes before alarm to 3 minutes after (captures the spike + immediate aftermath)
    start = alarmEpoch - 120;
    end = alarmEpoch + 180;
  } else {
    end = Math.floor(Date.now() / 1000);
    start = end - minutesBack * 60;
  }

  // Query 1: Error patterns — extract error_type and target service from JSON
  const query = `fields @timestamp, @message
| filter @message like /ERROR/
| parse @message '"error_type":"*"' as error_type
| parse @message '"message":"*"' as error_msg
| parse @message '"upstream_service":"*"' as upstream_svc
| stats count(*) as cnt, earliest(@timestamp) as first_seen, latest(@timestamp) as last_seen by coalesce(error_type, substr(error_msg, 0, 80), 'unknown') as pattern
| sort cnt desc
| limit 10`;

  // Query 2: Error timeline (1-minute buckets) — when errors started/stopped
  const timelineQuery = `fields @timestamp
| filter @message like /ERROR/
| stats count(*) as error_count by bin(1m) as time_bucket
| sort time_bucket asc
| limit 15`;

  // Run both queries in parallel
  const [patternResp, timelineResp] = await Promise.all([
    cwl.send(new StartQueryCommand({ logGroupName: LOG_GROUP, startTime: start, endTime: end, queryString: query })),
    cwl.send(new StartQueryCommand({ logGroupName: LOG_GROUP, startTime: start, endTime: end, queryString: timelineQuery })),
  ]);

  // Poll for both results
  async function pollQuery(queryId) {
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const resp = await cwl.send(new GetQueryResultsCommand({ queryId }));
      if (resp.status === 'Complete') return resp.results;
    }
    return null;
  }

  const [patternResults, timelineResults] = await Promise.all([
    pollQuery(patternResp.queryId),
    pollQuery(timelineResp.queryId),
  ]);

  if (!patternResults) return { service: SERVICE, error: 'Logs query timed out' };

  const patterns = (patternResults || []).map(row => {
    const pattern = row.find(f => f.field === 'pattern')?.value || 'unknown';
    const cnt = Number(row.find(f => f.field === 'cnt')?.value || 0);
    const firstSeen = row.find(f => f.field === 'first_seen')?.value || '';
    const lastSeen = row.find(f => f.field === 'last_seen')?.value || '';
    return { error_type: pattern.slice(0, 150), count: cnt, first_seen: firstSeen, last_seen: lastSeen };
  });

  const totalErrors = patterns.reduce((s, p) => s + p.count, 0);

  // Error timeline — shows when errors started and stopped
  const timeline = (timelineResults || []).map(row => ({
    time: row.find(f => f.field === 'time_bucket')?.value || '',
    errors: Number(row.find(f => f.field === 'error_count')?.value || 0),
  })).sort((a, b) => a.time.localeCompare(b.time));

  // Get one sample error message so agent sees the actual text (token-efficient: just 1 sample)
  let sampleError = '';
  if (totalErrors > 0) {
    try {
      const sampleResp = await cwl.send(new StartQueryCommand({
        logGroupName: LOG_GROUP, startTime: start, endTime: end,
        queryString: `fields @message | filter @message like /ERROR/ | parse @message '"message":"*"' as msg | display msg | limit 1`,
      }));
      const sampleResults = await pollQuery(sampleResp.queryId);
      sampleError = sampleResults?.[0]?.find(f => f.field === 'msg')?.value || '';
    } catch { /* non-critical */ }
  }

  return {
    service: SERVICE,
    window: { from: new Date(start * 1000).toISOString(), to: new Date(end * 1000).toISOString() },
    window_minutes: minutesBack,
    total_errors: totalErrors,
    top_patterns: patterns,
    error_timeline: timeline,
    sample_error_message: sampleError.slice(0, 200),
    note: totalErrors === 0
      ? 'No errors found in this window. The incident may have already resolved.'
      : `${totalErrors} errors found. See top_patterns for error types with first/last seen timestamps.`,
  };
}

// ── get_recent_deploys (ECS task definition history) ────────
async function getRecentDeploys(params) {
  // Get current service to find its task definition family
  const svcResp = await ecs.send(new DescribeServicesCommand({ cluster: CLUSTER, services: [SERVICE] }));
  const currentTdArn = svcResp.services?.[0]?.taskDefinition || '';
  // ARN format: arn:aws:ecs:region:account:task-definition/FamilyName:revision
  const tdPart = currentTdArn.split('task-definition/')[1] || '';
  const family = tdPart.split(':')[0] || '';

  const resp = await ecs.send(new ListTaskDefinitionsCommand({
    familyPrefix: family || undefined,
    sort: 'DESC',
    maxResults: 5,
  }));

  const deploys = [];
  for (const arn of (resp.taskDefinitionArns || []).slice(0, 5)) {
    const td = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: arn }));
    const def = td.taskDefinition;
    deploys.push({
      version: `${def.family}:${def.revision}`,
      registered_at: def.registeredAt?.toISOString(),
      image: def.containerDefinitions?.[0]?.image?.split(':').pop() || 'latest',
      cpu: def.cpu,
      memory: def.memory,
    });
  }

  return { service: SERVICE, deploys };
}

