import { SettingsForm } from "@/components/settings-form";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <main>
      <div className="page-head">
        <h1>Settings</h1>
        <p className="dim">
          Quality, limits, the Telegram bot and where jobs are stored. Values saved here live in your database
          and override the environment, so you can change them without a redeploy.
        </p>
      </div>
      <SettingsForm />
    </main>
  );
}
