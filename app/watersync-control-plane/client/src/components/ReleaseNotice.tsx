import { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@databricks/appkit-ui/react';
import { ExternalLink, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import { renderReleaseNotes } from '../lib/releaseNotes';
import { isNewerVersion } from '../lib/version';
import type { LatestRelease } from '../types';

/** A warning triangle next to the version when a newer WaterSync release is published; opens its notes. */
export function ReleaseNotice({ currentVersion }: { currentVersion: string }) {
  const [release, setRelease] = useState<LatestRelease | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // Best effort: without an answer (no internet access from the workspace, no release yet) nothing is shown.
    api<{ release: LatestRelease | null }>('/api/latest-release')
      .then((result) => setRelease(result.release))
      .catch(() => undefined);
  }, []);
  if (!release || !isNewerVersion(release.version, currentVersion)) return null;
  const notes = renderReleaseNotes(release.notes);
  return (
    <>
      <button
        type="button"
        className="release-notice"
        onClick={() => setOpen(true)}
        aria-label={`WaterSync ${release.version} is available. Show what changed`}
        title={`WaterSync ${release.version} is available`}
      >
        <TriangleAlert className="h-4 w-4" aria-hidden="true" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>WaterSync {release.version} is available</DialogTitle>
            <DialogDescription>
              You are running v{currentVersion}.
              {release.publishedAt &&
                ` ${release.name} was released on ${new Date(release.publishedAt).toLocaleDateString()}.`}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1 text-sm text-muted-foreground">
            {notes.length ? notes : <p>This release has no notes.</p>}
          </div>
          <DialogFooter className="items-center gap-3 sm:justify-between">
            <p className="text-xs text-muted-foreground">To update, redeploy the app from this release.</p>
            <Button asChild>
              <a href={release.url} target="_blank" rel="noreferrer">
                View release on GitHub
                <ExternalLink className="ml-2 h-4 w-4" />
              </a>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
