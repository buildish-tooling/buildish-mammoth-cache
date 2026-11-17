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

# Changelog

## Unreleased

- Rename verified Gradle wrapper metadata to `gradle-wrapper-<version>.jar.sha256`
  and `gradle-wrapper-<version>.jar.asc`. The checksum filename lets custom launchers
  retain Mammoth's verified wrapper JAR. Scripts consuming the previous
  `gradle-wrapper-<version>.sha256` or `gradle-wrapper-<version>.asc` files must use
  the new names. Provisioning no longer writes the previous names; existing files
  at those paths are left in place.
