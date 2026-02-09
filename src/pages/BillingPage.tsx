import { Billing } from "../components/Billing";

export function BillingPage() {
  return (
    <div className="p-6 h-full flex flex-col">
      <div className="mb-4">
        <h1 className="text-xl font-semibold" style={{ color: "var(--text-primary)" }}>
          Billing
        </h1>
        <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
          Credits, usage, and payments
        </p>
      </div>
      <div className="flex-1 overflow-auto">
        <Billing />
      </div>
    </div>
  );
}
