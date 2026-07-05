export type MergeRequestInput = {
  sourceProfileId: string;
  targetProfileId: string;
};

export function assertMergeRequestIsValid(input: MergeRequestInput): void {
  if (input.sourceProfileId === input.targetProfileId) {
    throw new Error(
      "Profile merge request source and target must not be the same profile."
    );
  }
}
