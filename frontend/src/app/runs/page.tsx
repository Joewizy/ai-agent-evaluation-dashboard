import { Suspense } from "react";
import { RunsView } from "@/components/runs";
import { Loading } from "@/components/ui";

export default function RunsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <RunsView />
    </Suspense>
  );
}
