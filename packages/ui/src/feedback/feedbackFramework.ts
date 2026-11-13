import {
  DEFAULT_FEEDBACK_TICKET_FRAMEWORK,
  type NibiProvider,
  type FeedbackTicketFramework,
} from "@nibi/shared";

export function inferFeedbackFrameworkFromAgentProvider(
  _provider: NibiProvider | null | undefined,
): FeedbackTicketFramework {
  return DEFAULT_FEEDBACK_TICKET_FRAMEWORK;
}
