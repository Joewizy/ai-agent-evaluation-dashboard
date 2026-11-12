import { Suspense } from "react";
import { RunView } from "@/components/run/run-view";
import { Loading } from "@/components/ui";

export default function RunPage() {
  return (
    <Suspense fallback={<Loading />}>
      <RunView />
    </Suspense>
  );
}
