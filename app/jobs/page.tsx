import { JobList } from "@/components/job-list";

export const dynamic = "force-dynamic";

export default function JobsPage() {
  return (
    <main>
      <div className="page-head">
        <h1>History</h1>
        <p className="dim">
          Every job is stored in your database: what came in, what went out, how long it took and what the
          converter said. Jobs waiting for a worker keep their place in the queue.
        </p>
      </div>
      <JobList />
    </main>
  );
}
