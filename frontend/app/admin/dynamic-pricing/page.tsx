import AdminFeaturePage from "@/components/admin/AdminFeaturePage";

export default function DynamicPricingPage() {
  return (
    <AdminFeaturePage
      actionLabel="Add Rule"
      description="Manage rules that adjust green fees by day, time window, demand, occupancy, and lead time before tee-off."
      metrics={[
        { label: "Active Rules", value: "6" },
        { label: "Avg Uplift", value: "+8.5%" },
        { label: "Twilight Discounts", value: "3" },
        { label: "Protected Rates", value: "12" },
      ]}
      rows={[
        { name: "Weekend Morning Premium", detail: "Sat-Sun 7:00-10:30 AM when occupancy exceeds 80%", status: "Active" },
        { name: "Twilight Saver", detail: "After 4:00 PM 9-hole and 18-hole discounted rates", status: "Active" },
        { name: "Low Demand Recovery", detail: "Reduce public rate by $7 when same-day occupancy is under 45%", status: "Paused" },
      ]}
      screen="dynamic_pricing"
      title="Dynamic Pricing"
    />
  );
}
