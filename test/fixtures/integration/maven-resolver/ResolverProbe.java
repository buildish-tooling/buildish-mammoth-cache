/*
 * Copyright 2026 The Buildish Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// Uses the installed Maven distribution's production Resolver and enhanced LRM.
// No user settings, public remotes, plugins, or downloaded harness dependencies.
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.apache.maven.repository.internal.MavenRepositorySystemUtils;
import org.codehaus.plexus.DefaultContainerConfiguration;
import org.codehaus.plexus.DefaultPlexusContainer;
import org.eclipse.aether.RepositorySystem;
import org.eclipse.aether.artifact.DefaultArtifact;
import org.eclipse.aether.installation.InstallRequest;
import org.eclipse.aether.repository.LocalRepository;
import org.eclipse.aether.repository.RemoteRepository;
import org.eclipse.aether.repository.RepositoryPolicy;
import org.eclipse.aether.resolution.ArtifactRequest;

public class ResolverProbe {
  public static void main(String[] args) throws Exception {
    var container = new DefaultPlexusContainer(new DefaultContainerConfiguration()
        .setClassPathScanning("index").setAutoWiring(true));
    try {
      var system = container.lookup(RepositorySystem.class);
      var session = MavenRepositorySystemUtils.newSession();
      session.setLocalRepositoryManager(system.newLocalRepositoryManager(
          session, new LocalRepository(args[0])));
      System.out.println("LRM=" + session.getLocalRepositoryManager().getClass().getName());
      var artifact = new DefaultArtifact(args[1]);
      if (args[2].equals("install")) {
        system.install(session, new InstallRequest().addArtifact(
            artifact.setFile(Path.of(args[3]).toFile())));
      } else {
        session.setOffline(Boolean.parseBoolean(args[2]));
        var policy = new RepositoryPolicy(true, args[5], "ignore");
        var builder = new RemoteRepository.Builder(args[3], "default", args[4]).setPolicy(policy);
        if (args.length > 6) {
          builder.setMirroredRepositories(List.of(
              new RemoteRepository.Builder(args[6], "default", args[4]).build()));
        }
        var result = system.resolveArtifact(session,
            new ArtifactRequest(artifact, List.of(builder.build()), ""));
        System.out.println("RESULT=" + Files.readString(result.getArtifact().getFile().toPath()));
      }
    } finally {
      container.dispose();
    }
  }
}
