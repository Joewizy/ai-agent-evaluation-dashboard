import { Suspense } from "react";
import { TodayView } from "@/components/today";
import { Loading } from "@/components/ui";

export default function TodayPage() {
  return (
    <Suspense fallback={<Loading />}>
      <TodayView />
    </Suspense>
  );
}
