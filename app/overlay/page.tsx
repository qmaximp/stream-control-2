import OverlayClient from "@/components/OverlayClient";
import ErrorBoundary from "@/components/ErrorBoundary";
import { invalidLinkScreen, isValidRoomToken } from "@/lib/links";

export const dynamic = "force-dynamic";

export default function Overlay({ searchParams }: { searchParams?: { room?: string } }) {
  if (!isValidRoomToken(searchParams?.room)) {
    return invalidLinkScreen();
  }
  return (
    <ErrorBoundary>
      <OverlayClient room={searchParams?.room} />
    </ErrorBoundary>
  );
}
