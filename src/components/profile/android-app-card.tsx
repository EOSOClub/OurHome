import { Download, Smartphone } from 'lucide-react';
import type { AppRelease } from '@/server/services/appDownloadService';
import { buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

// The Android app this server built (deploy.sh), with install notes. Only
// rendered when a build exists. A plain link: the browser downloads the APK
// with the session cookie, and /api/app/download checks it.
export function AndroidAppCard({ release }: { release: AppRelease }) {
  const built = new Date(release.builtAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const size = `${(release.sizeBytes / 1_048_576).toFixed(1)} MB`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="h-5 w-5" /> Android app
        </CardTitle>
        <CardDescription>
          Built for this server{release.firebase ? ', with instant alerts' : ''}.
          Version {release.versionName}, {size}, built {built}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <a href="/api/app/download" download className={buttonVariants()}>
          <Download className="h-4 w-4" /> Download for Android
        </a>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>
            Open the downloaded file on your phone. Android asks once to allow
            installs from your browser.
          </li>
          <li>
            Updates install over the old version, so you stay signed in.
          </li>
          {release.server ? (
            <li>It connects to {release.server} by itself.</li>
          ) : (
            <li>On first start it asks for this site&apos;s address.</li>
          )}
        </ul>
      </CardContent>
    </Card>
  );
}
