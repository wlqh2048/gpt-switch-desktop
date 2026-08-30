import {
  ApplyResult,
  BootstrapState,
  CustomProfileInput,
  DisplayProfile,
  ProviderCatalog,
  SyncProgress,
} from "../shared/types";

declare global {
  interface Window {
    aiModel: {
      bootstrap: {
        get(): Promise<BootstrapState>;
      };
      catalog: {
        refresh(): Promise<{ success: boolean; catalog: ProviderCatalog; profiles: DisplayProfile[]; message?: string }>;
      };
      profiles: {
        list(): Promise<{
          success: boolean;
          profiles: DisplayProfile[];
          active: BootstrapState["active"];
          catalogError?: string;
          message?: string;
        }>;
        saveOfficialKey(payload: { providerId: string; model: string }): Promise<{
          success: boolean;
          profiles: DisplayProfile[];
          catalogError?: string;
          message?: string;
        }>;
        create(payload: CustomProfileInput): Promise<{
          success: boolean;
          profiles: DisplayProfile[];
          catalogError?: string;
          message?: string;
        }>;
        update(
          id: string,
          payload: CustomProfileInput,
        ): Promise<{ success: boolean; profiles: DisplayProfile[]; catalogError?: string; message?: string }>;
        delete(
          id: string,
        ): Promise<{ success: boolean; profiles: DisplayProfile[]; catalogError?: string; message?: string }>;
        apply(
          id: string,
          options?: { apiKey?: string },
        ): Promise<ApplyResult & { profiles?: DisplayProfile[]; catalogError?: string }>;
      };
      runtime: {
        restartChatGPT(): Promise<{ success: boolean; message: string }>;
        openExternal(url: string): Promise<void>;
        openCodexDir(): Promise<string>;
      };
      sync: {
        onProgress(callback: (progress: SyncProgress) => void): () => void;
      };
      window: {
        minimize(): Promise<void>;
        close(): Promise<void>;
      };
    };
  }
}
