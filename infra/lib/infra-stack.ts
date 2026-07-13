import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

export class NightwatchRealStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── Parameters ──────────────────────────────────────────
    const chaosToken = new cdk.CfnParameter(this, 'ChaosToken', {
      type: 'String', default: 'chaos-secret', noEcho: true,
      description: 'Bearer token for chaos endpoint',
    });

    const bedrockAgentId = new cdk.CfnParameter(this, 'BedrockAgentId', {
      type: 'String', default: '',
      description: 'Existing Bedrock Agent ID',
    });

    const bedrockAliasId = new cdk.CfnParameter(this, 'BedrockAliasId', {
      type: 'String', default: '',
      description: 'Existing Bedrock Agent Alias ID',
    });

    const slackWebhookUrl = new cdk.CfnParameter(this, 'SlackWebhookUrl', {
      type: 'String', default: '', noEcho: true,
      description: 'Slack webhook URL (optional)',
    });

    // ═══════════════════════════════════════════════════════
    // RESOURCE 1: VPC ($0/month — no NAT)
    // ═══════════════════════════════════════════════════════
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });

    // ═══════════════════════════════════════════════════════
    // RESOURCE 2: ECS Cluster + Fargate Service (~$9/month)
    // No ALB — uses public IP directly (saves ~$16/month)
    // IP changes on task restart — fine for demo
    // ═══════════════════════════════════════════════════════
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: 'nightwatch-cluster',
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
    });

    const logGroup = new logs.LogGroup(this, 'AppLogs', {
      logGroupName: '/ecs/nightwatch-checkout',
      retention: logs.RetentionDays.THREE_DAYS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const image = new ecr_assets.DockerImageAsset(this, 'AppImage', {
      directory: path.join(__dirname, '../../checkout-service'),
    });

    taskDef.addContainer('app', {
      image: ecs.ContainerImage.fromDockerImageAsset(image),
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'app' }),
      environment: {
        CHAOS_TOKEN: chaosToken.valueAsString,
        APP_VERSION: process.env.APP_VERSION || 'v1',
        NODE_ENV: 'production',
      },
      portMappings: [{ containerPort: 3000 }],
    });

    // Security group — only port 3000 open
    const sg = new ec2.SecurityGroup(this, 'AppSg', { vpc, allowAllOutbound: true });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3000), 'App port');

    const fargateService = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: true, // Direct public IP, no ALB
      securityGroups: [sg],
      serviceName: 'checkout-service',
    });

    // ═══════════════════════════════════════════════════════
    // RESOURCE 3: CloudWatch Alarm ($0.10/month)
    // ═══════════════════════════════════════════════════════
    const errorFilter = new logs.MetricFilter(this, 'ErrorFilter', {
      logGroup,
      filterPattern: logs.FilterPattern.literal('"ERROR"'),
      metricNamespace: 'Nightwatch/CheckoutService',
      metricName: 'ErrorCount',
      metricValue: '1',
      defaultValue: 0,
    });

    const alarm = new cloudwatch.Alarm(this, 'ErrorAlarm', {
      alarmName: 'nightwatch-checkout-error-rate',
      metric: errorFilter.metric({ statistic: 'Sum', period: cdk.Duration.minutes(1) }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ═══════════════════════════════════════════════════════
    // RESOURCE 4: SNS Topic ($0/month)
    // Only CloudWatch can publish
    // ═══════════════════════════════════════════════════════
    const topic = new sns.Topic(this, 'AlarmTopic', {
      topicName: 'nightwatch-alarm',
    });
    alarm.addAlarmAction(new cw_actions.SnsAction(topic));

    topic.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['SNS:Publish'],
      resources: [topic.topicArn],
    }));

    // ═══════════════════════════════════════════════════════
    // RESOURCE 5: DynamoDB ($0/month — on-demand)
    // ═══════════════════════════════════════════════════════
    const table = new dynamodb.Table(this, 'InvestigationTable', {
      tableName: 'nightwatch-investigations',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ═══════════════════════════════════════════════════════
    // RESOURCE 6: Tool Lambda ($0/month)
    // STRICT READ-ONLY — reads CloudWatch/ECS only
    // No KB search — first responder reads real data only
    // ═══════════════════════════════════════════════════════
    const toolLambda = new lambda.Function(this, 'ToolLambda', {
      functionName: 'nightwatch-tools',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../tool-lambda/src')),
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        CLUSTER_NAME: cluster.clusterName,
        SERVICE_NAME: 'checkout-service',
        LOG_GROUP_NAME: logGroup.logGroupName,
      },
    });

    // READ-ONLY: scoped to our resources
    toolLambda.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadOnlyECS',
      effect: iam.Effect.ALLOW,
      actions: [
        'ecs:DescribeServices', 'ecs:DescribeTasks', 'ecs:ListTasks',
        'ecs:ListTaskDefinitions', 'ecs:DescribeTaskDefinition',
      ],
      resources: ['*'], // ECS Describe/List actions require * for ListTaskDefinitions
    }));

    toolLambda.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadOnlyCloudWatch',
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:GetMetricData', 'cloudwatch:DescribeAlarms'],
      resources: ['*'],
    }));

    toolLambda.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadOnlyLogs',
      effect: iam.Effect.ALLOW,
      actions: ['logs:StartQuery', 'logs:GetQueryResults'],
      resources: [logGroup.logGroupArn],
    }));

    // EXPLICIT DENY on all writes
    toolLambda.addToRolePolicy(new iam.PolicyStatement({
      sid: 'DenyAllWrites',
      effect: iam.Effect.DENY,
      actions: [
        'ecs:UpdateService', 'ecs:StopTask', 'ecs:RunTask',
        'ecs:DeleteService', 'ecs:CreateService',
        'ec2:*', 'rds:*', 'iam:*',
        'lambda:InvokeFunction', 'lambda:UpdateFunctionCode',
        's3:PutObject', 's3:DeleteObject',
        'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:UpdateItem',
      ],
      resources: ['*'],
    }));

    toolLambda.addPermission('BedrockInvoke', {
      principal: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      sourceAccount: this.account,
    });

    // ═══════════════════════════════════════════════════════
    // RESOURCE 7: Trigger Lambda ($0/month)
    // Writes ONLY to our investigation table
    // ═══════════════════════════════════════════════════════
    const triggerLambda = new lambda.Function(this, 'TriggerLambda', {
      functionName: 'nightwatch-trigger',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../trigger-lambda/src')),
      memorySize: 256,
      timeout: cdk.Duration.seconds(120),
      environment: {
        BEDROCK_AGENT_ID: bedrockAgentId.valueAsString,
        BEDROCK_AGENT_ALIAS_ID: bedrockAliasId.valueAsString,
        INVESTIGATION_TABLE: table.tableName,
        SLACK_WEBHOOK_URL: slackWebhookUrl.valueAsString,
      },
    });

    triggerLambda.addToRolePolicy(new iam.PolicyStatement({
      sid: 'InvokeBedrockAgent',
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeAgent'],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:agent-alias/${bedrockAgentId.valueAsString}/${bedrockAliasId.valueAsString}`,
      ],
    }));

    table.grantReadWriteData(triggerLambda);

    // EXPLICIT DENY on everything else
    triggerLambda.addToRolePolicy(new iam.PolicyStatement({
      sid: 'DenyEverythingElse',
      effect: iam.Effect.DENY,
      actions: ['ecs:*', 'ec2:*', 'rds:*', 'lambda:UpdateFunctionCode', 's3:*', 'iam:*'],
      resources: ['*'],
    }));

    topic.addSubscription(new sns_subs.LambdaSubscription(triggerLambda));

    // ═══════════════════════════════════════════════════════
    // OUTPUTS
    // ═══════════════════════════════════════════════════════
    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'ServiceName', { value: 'checkout-service' });
    new cdk.CfnOutput(this, 'ToolLambdaArn', { value: toolLambda.functionArn });
    new cdk.CfnOutput(this, 'TriggerLambdaArn', { value: triggerLambda.functionArn });
    new cdk.CfnOutput(this, 'LogGroupName', { value: logGroup.logGroupName });
    new cdk.CfnOutput(this, 'AlarmName', { value: alarm.alarmName });
    new cdk.CfnOutput(this, 'InvestigationTableName', { value: table.tableName });

    new cdk.CfnOutput(this, 'GetTaskIP', {
      value: `aws ecs list-tasks --cluster nightwatch-cluster --service checkout-service --query "taskArns[0]" --output text | xargs -I {} aws ecs describe-tasks --cluster nightwatch-cluster --tasks {} --query "tasks[0].attachments[0].details[?name=='networkInterfaceId'].value" --output text | xargs -I {} aws ec2 describe-network-interfaces --network-interface-ids {} --query "NetworkInterfaces[0].Association.PublicIp" --output text`,
      description: 'Run this command to get the task public IP',
    });

    // ── Tags + Cost Summary ─────────────────────────────────
    cdk.Tags.of(this).add('Project', 'Nightwatch');
    cdk.Tags.of(this).add('CostCenter', 'nightwatch-demo');

    new cdk.CfnOutput(this, 'CostEstimate', {
      value: 'VPC: $0 | ECS: ~$9/mo | CW Alarm: $0.10/mo | SNS/Lambda/DDB: $0 | NO ALB: saves $16/mo | Total: ~$10/mo always-on',
    });

    new cdk.CfnOutput(this, 'SecurityNote', {
      value: 'Tool Lambda: READ-ONLY with explicit DENY on all writes. Trigger Lambda: writes only to nightwatch-investigations table.',
    });
  }
}
