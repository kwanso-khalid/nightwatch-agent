import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NightwatchRealStack } from '../lib/infra-stack';

test('Stack creates required resources', () => {
  const app = new cdk.App();
  const stack = new NightwatchRealStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::ECS::Cluster', 1);
  template.resourceCountIs('AWS::Lambda::Function', 2);
  template.resourceCountIs('AWS::DynamoDB::Table', 1);
  template.resourceCountIs('AWS::SNS::Topic', 1);
  template.resourceCountIs('AWS::CloudWatch::Alarm', 1);
});
