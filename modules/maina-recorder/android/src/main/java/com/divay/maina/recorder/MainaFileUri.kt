package com.divay.maina.recorder

import java.io.File
import java.net.URI

/** Resolve both Java's file:/path form and Expo's file:///path form. */
internal fun mainaFileFromUriOrPath(uriOrPath: String): File =
    if (uriOrPath.startsWith("file:")) File(URI(uriOrPath)) else File(uriOrPath)
