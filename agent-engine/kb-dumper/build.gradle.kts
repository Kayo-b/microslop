plugins {
    java
    application
}

group = "net.runelite.agentengine"
version = "0.1.0"

dependencies {
    implementation("net.runelite:cache:1.13.0")
    implementation(libs.gson)
    runtimeOnly(libs.slf4j.simple)
}

java {
    toolchain { languageVersion.set(JavaLanguageVersion.of(17)) }
}

tasks.withType<JavaCompile> {
    options.encoding = "UTF-8"
    options.release.set(11)
}

application {
    mainClass.set("net.runelite.agentengine.kb.KbDumper")
}
