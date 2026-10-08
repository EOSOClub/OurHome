# syntax=docker/dockerfile:1.7
#
# Builds the Our Home Android app as a release APK signed with this install's
# key, with this install's server address and app id built in. deploy.sh runs
# it with:
#
#   --build-context app=<OurHomeApp repo#branch>   the app's source (GitHub)
#   --build-context config=<folder>               settings.yml (+ google-services.json)
#   --secret id=keystore / id=keystore_password    the signing key, never in a layer
#   --output type=local,dest=<folder>             receives ourhome.apk
#
# The Android SDK layer is cached, and so is Gradle's download cache, so only
# the first build is slow.

FROM eclipse-temurin:21-jdk AS sdk
# Android command-line tools 19.0; AGP 9.4 builds with the packages below.
ARG CMDLINE_TOOLS=13114758
ENV ANDROID_HOME=/opt/android-sdk
ENV PATH=$PATH:/opt/android-sdk/cmdline-tools/latest/bin
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip curl \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p "$ANDROID_HOME/cmdline-tools" \
 && curl -fsSL -o /tmp/tools.zip "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip" \
 && unzip -q /tmp/tools.zip -d "$ANDROID_HOME/cmdline-tools" \
 && mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest" \
 && rm /tmp/tools.zip \
 && (yes | sdkmanager --licenses >/dev/null) \
 && sdkmanager "platforms;android-37.0" "build-tools;36.0.0" >/dev/null

FROM sdk AS build
WORKDIR /src
COPY --from=app . .
COPY --from=config . /config/
ARG VERSION_CODE=1
ARG VERSION_NAME=0.1.0
# A local checkout's SDK path doesn't exist here; the install's settings and
# Firebase file replace whatever the source had.
RUN --mount=type=cache,target=/root/.gradle \
    --mount=type=secret,id=keystore,target=/run/secrets/keystore.jks \
    --mount=type=secret,id=keystore_password \
    rm -f local.properties \
 && cp /config/settings.yml settings.yml \
 && rm -f OurHomeApp/google-services.json \
 && if [ -f /config/google-services.json ]; then cp /config/google-services.json OurHomeApp/; fi \
 && OURHOME_KEYSTORE=/run/secrets/keystore.jks \
    OURHOME_KEYSTORE_PASSWORD="$(cat /run/secrets/keystore_password)" \
    OURHOME_VERSION_CODE="$VERSION_CODE" \
    OURHOME_VERSION_NAME="$VERSION_NAME" \
    sh ./gradlew --no-daemon --console=plain -q assembleRelease \
 && mkdir /out \
 && cp OurHomeApp/build/outputs/apk/release/*.apk /out/ourhome.apk

FROM scratch AS out
COPY --from=build /out/ /
