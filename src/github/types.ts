export type GitHubAccountView = {
  connected: boolean;
  login?: string;
  hostname: "github.com";
  detail: string;
};

export type GitHubRemoteRepositoryView = {
  nameWithOwner: string;
  url: string;
  isPrivate: boolean;
  isFork: boolean;
  description: string;
  managedLocally: boolean;
};
