import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { CfnAnomalyMonitor, CfnAnomalySubscription, CfnCostCategory } from 'aws-cdk-lib/aws-ce';
import { ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

import { EnvironmentConfig } from '../config/types';
import { applyPlatformTags } from '../tags';

/**
 * Anomaly threshold: 10% of the monthly budget, floored at $10. Below that, daily anomalies are
 * billing noise (a one-off API call or a fractional-NAT hour); above it, something real changed -
 * a service left running, an unexpected replica, a price regression.
 */
function anomalyThresholdUsd(monthlyBudgetUsd: number): number {
  return Math.max(10, Math.round(monthlyBudgetUsd * 0.1));
}

export interface CostStackProps extends StackProps {
  /** Environment specific configuration. No environment value is hardcoded in this stack. */
  readonly config: EnvironmentConfig;
}

/**
 * Phase 9 cost guardrails, deployed once per environment.
 *
 * In the multi-account model an environment *is* an account, so the budget monitors the account
 * this stack lands in (`LinkedAccount` = the deploying account - explicit rather than assumed, so
 * the same template is correct whether the environment owns its account or shares one).
 *
 * Three mechanisms, three different failure modes:
 *
 * - **Budget notifications** catch *planned-spend drift*: the architecture quietly costing more
 *   than its ceiling. Actual at 80% tells you the money is spent; forecasted at 100% tells you
 *   before it is - the more useful of the two.
 * - **Anomaly detection** catches *unplanned-spend spikes*: a resource left running, an accidental
 *   deployment, a misconfigured transfer. Per-service, because "EC2 doubled" is actionable in a
 *   way "account spend is up 40%" is not.
 * - **Cost allocation** makes the bill explainable: the `Environment` cost category groups cost by
 *   the platform's tag contract, which is what turns "monthly cost report by Environment" from a
 *   manual Cost Explorer exercise into a first-class breakdown.
 *
 * Alerts land on `ecommerce-<env>-alerts` - the environment's shared notification topic, created
 * here because cost is the first alerting workload; Phase 7's alarm fan-out publishes to the same
 * topic rather than standing up a second one.
 */
export class CostStack extends Stack {
  /** The environment's alert topic; exported so later stacks (Phase 7 alarms) can publish to it. */
  public readonly alertsTopic: Topic;

  constructor(scope: Construct, id: string, props: CostStackProps) {
    super(scope, id, props);

    const { config } = props;
    const { environment } = config;
    const namePrefix = `ecommerce-${environment}`;

    this.alertsTopic = new Topic(this, 'AlertsTopic', {
      topicName: `${namePrefix}-alerts`,
      displayName: `E-commerce ${environment} alerts`,
    });
    // Budgets and Cost Explorer anomalies publish as AWS services, not as any principal in this
    // account, so the topic needs a resource policy allowing exactly those two.
    for (const service of ['budgets.amazonaws.com', 'ce.amazonaws.com']) {
      this.alertsTopic.grantPublish(new ServicePrincipal(service));
    }
    if (config.cost.alertEmail !== undefined) {
      // The subscription sends a confirmation email; alerting is live only after it is confirmed.
      this.alertsTopic.addSubscription(new EmailSubscription(config.cost.alertEmail));
    }

    const notifications: CfnBudget.NotificationProperty[] = [
      { comparisonOperator: 'GREATER_THAN', notificationType: 'ACTUAL', threshold: 80, thresholdType: 'PERCENTAGE' },
      { comparisonOperator: 'GREATER_THAN', notificationType: 'FORECASTED', threshold: 100, thresholdType: 'PERCENTAGE' },
    ];
    new CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `${namePrefix}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: config.cost.monthlyBudgetUsd, unit: 'USD' },
        costFilters: { LinkedAccount: [Stack.of(this).account] },
      },
      notificationsWithSubscribers: notifications.map((notification) => ({
        notification,
        subscribers: [{ subscriptionType: 'SNS', address: this.alertsTopic.topicArn }],
      })),
    });

    const anomalyMonitor = new CfnAnomalyMonitor(this, 'ServiceAnomalyMonitor', {
      monitorName: `${namePrefix}-service-anomalies`,
      monitorType: 'DIMENSIONAL',
      monitorDimension: 'SERVICE',
    });
    new CfnAnomalySubscription(this, 'AnomalySubscription', {
      subscriptionName: `${namePrefix}-anomaly-alerts`,
      monitorArnList: [anomalyMonitor.attrMonitorArn],
      frequency: 'DAILY',
      threshold: anomalyThresholdUsd(config.cost.monthlyBudgetUsd),
      subscribers: [{ type: 'SNS', address: this.alertsTopic.topicArn }],
    });

    // The cost report: "Environment" is a first-class Cost Explorer breakdown, sourced from the
    // platform tag every stack already applies.
    // `rules` is a JSON document, not a property list: each rule maps one value of the platform's
    // Environment tag onto a category value.
    new CfnCostCategory(this, 'EnvironmentCostCategory', {
      name: 'Environment',
      ruleVersion: 'CostCategoryExpression.v1',
      defaultValue: 'untagged',
      rules: JSON.stringify(
        (['dev', 'uat', 'prod'] as const).map((env) => ({
          Value: env,
          Rule: { Tags: { Key: 'Environment', Values: [env], MatchOptions: ['EQUALS'] } },
        })),
      ),
    });

    new CfnOutput(this, 'AlertsTopicArn', {
      value: this.alertsTopic.topicArn,
      description: 'SNS topic all environment alerts publish to',
      exportName: `${namePrefix}-alerts-topic-arn`,
    });

    applyPlatformTags(this, config);
  }
}
