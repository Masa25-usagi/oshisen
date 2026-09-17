import type { Metadata } from "next";
import { VoiceInterview } from "../../components/voice/interview";
export const metadata: Metadata = {
  title: "AIと話して、考えを整理する",
  referrer: "no-referrer",
};
export default function Page() {
  return <VoiceInterview />;
}
