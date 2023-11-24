# DevDB
A lightweight VS Code extension that auto-loads your database. It provides a beautiful database GUI client experience. Built with 💖 for developers.

DevDB brings [Convention over Configuration](https://en.wikipedia.org/wiki/Convention_over_configuration) into database management.

## Why?
Two words: Better DX.

DevDB aims to be a DB GUI client specifically designed for a much better development experience when working with databases.
Specifically, these experiences:
1. For any new project, it is usually required to setup db connection in the app project, **and** then in some other DB client.
2. It is common to frequently tab-in and tab-out of project windows, switching between the IDE and DB client. Sometimes, frequent enough to want to view the DB data directly in the IDE. Think of how you've got your in-built terminal right in the IDE.

Local DX should be better than this.

Also, most of the DB clients are clunky or simply overwhelming, with bells and whistles that are not really useful during local development flow. Usually, being able to simply _view_ DB data is all that is needed during local development.

Furthermore, who doesn't love beautiful UIs? DB clients have evolved to generally not have exciting UIs in my opinion, except just a few with excellent and intuitive UIs.

To address the above, there is a need for a database GUI tool that lives in the IDE, and mostly auto-detects and connects with the database configured in the currently opened workspace. It should be simple, fast, intuitive, and clean.

Hence, DevDB 🚀

## Keybinding
Press `Ctrl+K Ctrl+D` to bring up the view

## Configuration
Do not commit DevDB config file `.devdb.json` to version control.

## Disclaimer
DevDB does not aim to provide feature-parity with popular GUI database clients. This extension is focused at improving working with databased during application development.
