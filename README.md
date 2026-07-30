<!--
Copyright 2026 The Buildish Authors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# Buildish Mammoth Cache for Gradle and Maven

Buildish Mammoth Cache for Gradle and Maven provides local and distributed build cache
management for GitHub Actions — with secure Gradle wrapper provisioning for Gradle builds and
lightweight local-repository caching for Maven builds. Support for Codeberg/Forgejo and GitLab CI
is planned for the future.

The action is split by build tool. Reference the one that matches your project:

```yaml
# Gradle
- uses: buildish-tooling/buildish-mammoth-cache/actions/github/gradle@<commit-sha>

# Maven
- uses: buildish-tooling/buildish-mammoth-cache/actions/github/maven@<commit-sha>
```

Project documentation lives on the Buildish site:

- <https://buildish.org/components/mammoth-cache/>

Use the site docs for workflow usage, configuration, cache-partition behavior, security notes,
maintenance guidance, and current project status.

## License

See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
