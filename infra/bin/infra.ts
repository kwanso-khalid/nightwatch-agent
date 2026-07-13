#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NightwatchRealStack } from '../lib/infra-stack';

const app = new cdk.App();
new NightwatchRealStack(app, 'NightwatchRealStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
});
