import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { useSpeechStore } from "@multica/core/speech";
import { SidebarProvider } from "@multica/ui/components/ui/sidebar";
import { renderWithI18n } from "../test/i18n";
import { NowSpeaking } from "./now-speaking";

const push = vi.fn();
vi.mock("../navigation", () => ({ useNavigation: () => ({ push }) }));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/ws/issues/${id}` }),
}));

afterEach(() => {
  push.mockReset();
  useSpeechStore.setState({ speaking: null });
});

const render = () =>
  renderWithI18n(
    <SidebarProvider>
      <NowSpeaking />
    </SidebarProvider>,
  );

describe("NowSpeaking", () => {
  it("is hidden while nothing is read aloud", () => {
    render();
    expect(screen.queryByText(/Reading/)).toBeNull();
  });

  it("names the issue being read and opens it on click", () => {
    useSpeechStore.setState({
      speaking: { commentId: "c1", issueId: "i1", identifier: "MUL-7", projectId: null, preparing: false },
    });
    render();
    fireEvent.click(screen.getByText("Reading MUL-7"));
    expect(push).toHaveBeenCalledWith("/ws/issues/i1");
  });
});
