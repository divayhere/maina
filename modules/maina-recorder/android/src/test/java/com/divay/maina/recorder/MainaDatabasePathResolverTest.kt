package com.divay.maina.recorder

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Test

class MainaDatabasePathResolverTest {
    @Test
    fun prefersExpoSqliteDefaultDirectory() {
        val root = Files.createTempDirectory("maina-db-path").toFile()
        try {
            val filesDir = File(root, "files").apply { mkdirs() }
            val expoDatabase = File(File(filesDir, "SQLite"), "maina.db").apply {
                parentFile?.mkdirs()
                writeText("expo")
            }
            val legacyDatabase = File(root, "databases/maina.db").apply {
                parentFile?.mkdirs()
                writeText("legacy")
            }

            assertEquals(
                expoDatabase.canonicalPath,
                MainaDatabasePathResolver.resolve(filesDir, legacyDatabase).canonicalPath,
            )
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun fallsBackToLegacyAndroidDatabaseDirectory() {
        val root = Files.createTempDirectory("maina-db-path").toFile()
        try {
            val filesDir = File(root, "files").apply { mkdirs() }
            val legacyDatabase = File(root, "databases/maina.db").apply {
                parentFile?.mkdirs()
                writeText("legacy")
            }

            assertEquals(
                legacyDatabase.canonicalPath,
                MainaDatabasePathResolver.resolve(filesDir, legacyDatabase).canonicalPath,
            )
        } finally {
            root.deleteRecursively()
        }
    }
}
