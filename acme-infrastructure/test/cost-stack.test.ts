import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { getEnvironmentConfig } from '../lib/config';
import { EnvironmentName } from '../lib/config/types';
import { CostStack } from '../lib/stacks/cost-stack';

const TEST_ACCOUNT = '123456789012';

function buildTemplate(environment: EnvironmentName): Template {
  const app = new App();
  const config = getEnvironmentConfig(environment);
  const stack = new CostStack(app, `test-cost-${environment}`, {
    env: { account: TEST_ACCOUNT, region: config.region },
    config,
  });
  return Template.fromStack(stack);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

describe('CostStack guardrails', () => {
  test('creates a monthly cost budget scoped to the deploying account', () => {
    const template = buildTemplate('dev');

    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: {
        BudgetName: 'ecommerce-dev-monthly',
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: getEnvironmentConfig('dev').cost.monthlyBudgetUsd, Unit: 'USD' },
      },
    });
  });

  test('notifies at 80% actual and 100% forecasted spend', () => {
    const budget = Object.values(buildTemplate('dev').findResources('AWS::Budgets::Budget'))[0] as any;
    const rendered = json(budget.Properties.NotificationsWithSubscribers);

    // Actual spend already happened; the forecasted notification is the earlier warning.
    expect(rendered).toContain('"NotificationType":"ACTUAL"');
    expect(rendered).toContain('"NotificationType":"FORECASTED"');
    expect(rendered).toContain('"Threshold":80');
    expect(rendered).toContain('"Threshold":100');
    expect(rendered).toContain('"SubscriptionType":"SNS"');
  });

  test('watches every service for cost anomalies and alerts on them', () => {
    const template = buildTemplate('dev');

    template.hasResourceProperties('AWS::CE::AnomalyMonitor', {
      MonitorType: 'DIMENSIONAL',
      MonitorDimension: 'SERVICE',
    });
    const subscription = Object.values(template.findResources('AWS::CE::AnomalySubscription'))[0] as any;
    expect(json(subscription.Properties.Subscribers)).toContain('"Type":"SNS"');
  });

  test('makes Environment a first-class cost category for the monthly report', () => {
    const template = buildTemplate('dev');

    const category = Object.values(template.findResources('AWS::CE::CostCategory'))[0] as any;
    expect(category.Properties.Name).toBe('Environment');
    // Rules are a JSON document, not a property list.
    const rules = JSON.parse(category.Properties.Rules as string) as { Value: string }[];
    expect(rules.map((rule) => rule.Value).sort()).toEqual(['dev', 'prod', 'uat']);
  });

  test('creates the shared alerts topic the email subscription hangs off', () => {
    const template = buildTemplate('dev');

    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'ecommerce-dev-alerts',
    });
    template.hasOutput('AlertsTopicArn', {
      Export: { Name: 'ecommerce-dev-alerts-topic-arn' },
    });
  });
});
