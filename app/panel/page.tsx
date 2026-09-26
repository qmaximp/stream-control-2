import PanelClient from "@/components/PanelClient";
import { invalidLinkScreen, isValidRoomToken } from "@/lib/links";

export const dynamic = "force-dynamic";

export default function Panel({ searchParams }: { searchParams?: { room?: string } }) {
  if (!isValidRoomToken(searchParams?.room)) {
    return invalidLinkScreen();
  }
  return <PanelClient />;
}
