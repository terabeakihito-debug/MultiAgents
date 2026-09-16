import { listProjectProfiles } from "../server/project-profiles";

type ProfileListDependencies = {
  list: typeof listProjectProfiles;
};

export function createProfileListService(dependencies: ProfileListDependencies = {
  list: listProjectProfiles,
}) {
  return {
    load() {
      return dependencies.list();
    },
  };
}

/** Framework-independent project profile catalog read boundary used by transport adapters. */
export const profileListService = createProfileListService();
