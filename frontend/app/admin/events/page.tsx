import AdminFeaturePage from "@/components/admin/AdminFeaturePage";

export default function EventsPage() {
  return (
    <AdminFeaturePage
      actionLabel="Add Event"
      description="Schedule leagues, tournaments, shotgun starts, banquets, and tee sheet blocks that affect inventory."
      metrics={[
        { label: "Upcoming", value: "8" },
        { label: "Blocked Slots", value: "42" },
        { label: "Tournament Days", value: "3" },
        { label: "Private Events", value: "5" },
      ]}
      rows={[
        { name: "Saturday Members League", detail: "Recurring Saturday tee block from 7:00 AM to 9:30 AM", status: "Active" },
        { name: "Corporate Outing", detail: "Shotgun start with banquet room hold", status: "Active" },
        { name: "Junior Clinic", detail: "Practice area and front-nine partial block", status: "Draft" },
      ]}
      screen="events"
      title="Events"
    />
  );
}
