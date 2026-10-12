import { RemovalPolicy } from 'aws-cdk-lib';
import {
  FlowLog,
  FlowLogDestination,
  FlowLogResourceType,
  FlowLogTrafficType,
  IVpc,
} from 'aws-cdk-lib/aws-ec2';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface VpcFlowLogsProps {
  readonly vpc: IVpc;
  /** How long flow log events are kept. */
  readonly retention: RetentionDays;
  /** Removal policy of the log group: destroy with the stack, or retain it. */
  readonly removalPolicy: RemovalPolicy;
}

/**
 * VPC Flow Logs to CloudWatch Logs: an audit trail of the accepted and rejected traffic in the VPC,
 * which is the first thing needed when investigating how a workload was reached.
 *
 * `FlowLogDestination.toCloudWatchLogs` creates the delivery role for us with a policy scoped to
 * the log group created here, so no role is defined by hand and no wildcard permission is granted.
 * The log group is the only resource in Phase 1 that supports a removal policy, which is where the
 * per environment `removalPolicy` setting is applied.
 */
export class VpcFlowLogs extends Construct {
  public readonly logGroup: LogGroup;

  constructor(scope: Construct, id: string, props: VpcFlowLogsProps) {
    super(scope, id);

    this.logGroup = new LogGroup(this, 'LogGroup', {
      retention: props.retention,
      removalPolicy: props.removalPolicy,
    });

    new FlowLog(this, 'FlowLog', {
      resourceType: FlowLogResourceType.fromVpc(props.vpc),
      destination: FlowLogDestination.toCloudWatchLogs(this.logGroup),
      trafficType: FlowLogTrafficType.ALL,
    });
  }
}
