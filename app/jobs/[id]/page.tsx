import { JobDetail } from "@/components/job-detail";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main>
      <div className="page-head">
        <h1>Conversion</h1>
      </div>
      <JobDetail id={id} />
    </main>
  );
}
