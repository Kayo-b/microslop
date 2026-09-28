// Standalone build: dumps OSRS cache definitions and object placements to JSONL for the
// agent-engine knowledge base. Reuses Microbot's vendored RuneLite `cache` module so the
// decoders always match the client revision.
rootProject.name = "kb-dumper"

dependencyResolutionManagement {
    repositories {
        maven(uri("https://repo.runelite.net")) {
            content { includeGroupAndSubgroups("net.runelite") }
        }
        mavenCentral {
            content { excludeGroupAndSubgroups("net.runelite") }
        }
    }
    versionCatalogs {
        create("libs") {
            from(files("../../libs.versions.toml"))
        }
    }
}

includeBuild("../../cache")
