import { Tasks } from "./Tasks";

type Props = {
  gatewayRunning: boolean;
};

export function Jobs({ gatewayRunning }: Props) {
  return <Tasks gatewayRunning={gatewayRunning} view="jobs" />;
}

