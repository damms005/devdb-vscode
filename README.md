# DevDb

![image](https://private-user-images.githubusercontent.com/9839355/289929963-81f5f867-1be1-4671-80a0-d042c056faae.png?jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTEiLCJleHAiOjE3MDI0MjgyOTgsIm5iZiI6MTcwMjQyNzk5OCwicGF0aCI6Ii85ODM5MzU1LzI4OTkyOTk2My04MWY1Zjg2Ny0xYmUxLTQ2NzEtODBhMC1kMDQyYzA1NmZhYWUucG5nP1gtQW16LUFsZ29yaXRobT1BV1M0LUhNQUMtU0hBMjU2JlgtQW16LUNyZWRlbnRpYWw9QUtJQUlXTkpZQVg0Q1NWRUg1M0ElMkYyMDIzMTIxMyUyRnVzLWVhc3QtMSUyRnMzJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyMzEyMTNUMDAzOTU4WiZYLUFtei1FeHBpcmVzPTMwMCZYLUFtei1TaWduYXR1cmU9YzNjZGY1ZWExOTI4MDNkOTJiMzI5NzIyNWM3MDBkNzc1OTVhMDZiN2I4MDZhMjdmYjRjMzc1MDVkNGJjZTlhZCZYLUFtei1TaWduZWRIZWFkZXJzPWhvc3QmYWN0b3JfaWQ9MCZrZXlfaWQ9MCZyZXBvX2lkPTAifQ.deycfGt13BR33DfWg-H6amDzz6ncQJa8-J2AN60fkdE)

![image](https://private-user-images.githubusercontent.com/9839355/289935969-b1f1da49-d8d9-428e-820b-9c69197ac778.png?jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTEiLCJleHAiOjE3MDI0MjgyOTgsIm5iZiI6MTcwMjQyNzk5OCwicGF0aCI6Ii85ODM5MzU1LzI4OTkzNTk2OS1iMWYxZGE0OS1kOGQ5LTQyOGUtODIwYi05YzY5MTk3YWM3NzgucG5nP1gtQW16LUFsZ29yaXRobT1BV1M0LUhNQUMtU0hBMjU2JlgtQW16LUNyZWRlbnRpYWw9QUtJQUlXTkpZQVg0Q1NWRUg1M0ElMkYyMDIzMTIxMyUyRnVzLWVhc3QtMSUyRnMzJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyMzEyMTNUMDAzOTU4WiZYLUFtei1FeHBpcmVzPTMwMCZYLUFtei1TaWduYXR1cmU9ODA1NGRlMGYwNTZhMzc4NTlhOWQ2Zjc3M2FmOGVhZTA4N2Q0ZDM1ODI2MGRlOGFkNDc4ODc4ZWRjOTIxMzE5OCZYLUFtei1TaWduZWRIZWFkZXJzPWhvc3QmYWN0b3JfaWQ9MCZrZXlfaWQ9MCZyZXBvX2lkPTAifQ.sZ0xAysMJfS-_xLSjctCKzWdWC7Qc5ubczNgujznqgg)

A lightweight VS Code extension that auto-loads your database. It provides a beautiful database GUI client experience. It brings [Convention over Configuration](https://en.wikipedia.org/wiki/Convention_over_configuration) into database management.

Built with 💖 for developers.

## Requirements

- VS Code 1.83 or newer
- A VS Code project that uses any of the [supported databases](#supported-databases)

## Quick Start

- In a VS Code project using any of the [supported databases](#supported-databases), ensure your database is properly set up and you are able to connect to your database as usual from your normal app code.
- DevDb [loads your database](#loading-databases). You can view your database by opening the DevDb (usually before the Terminal tab) as shown in the screenshot below, or by using the [shortcut](#keybinding):

![image](https://private-user-images.githubusercontent.com/9839355/289928005-bce3b771-b7dd-4bde-af9f-df04d06a760c.png?jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTEiLCJleHAiOjE3MDI0MjgyOTgsIm5iZiI6MTcwMjQyNzk5OCwicGF0aCI6Ii85ODM5MzU1LzI4OTkyODAwNS1iY2UzYjc3MS1iN2RkLTRiZGUtYWY5Zi1kZjA0ZDA2YTc2MGMucG5nP1gtQW16LUFsZ29yaXRobT1BV1M0LUhNQUMtU0hBMjU2JlgtQW16LUNyZWRlbnRpYWw9QUtJQUlXTkpZQVg0Q1NWRUg1M0ElMkYyMDIzMTIxMyUyRnVzLWVhc3QtMSUyRnMzJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyMzEyMTNUMDAzOTU4WiZYLUFtei1FeHBpcmVzPTMwMCZYLUFtei1TaWduYXR1cmU9YTQxNWMxZjNmNDY5MWU4ODM0ZDE1ODEwMjAxMWU3NDM0ZGMyOTQ1MmYzMTkxYTZkYTNkNDE1ZjVhZDIzOTkyOCZYLUFtei1TaWduZWRIZWFkZXJzPWhvc3QmYWN0b3JfaWQ9MCZrZXlfaWQ9MCZyZXBvX2lkPTAifQ.CF7I2HI_FlW2elflcD5qnBXPSnBaLp_QbUQ_KG_U6J8)


> [!NOTE]
> DevDb provides some [Language and Framework Integrations](#language-and-framework-integrations)

## Loading databases

DevDb can automatically load your database using connection details from your project.

### Automatic database loading (zero-config)

The following environments are currently supported:

1. Laravel with local default SQLite database
1. Laravel MySQL with default .env config
1. Containerized Laravel MySQL (Laravel Sail) with config in default .env/docker-compose.yml

### Config-base database loading

If there is no [zero-config support](#automatic-database-loading-zero-config) for your environment, then simply provide a `.devdbrc` file in the root of your project. DevDb will connect to and load your database using this configuration file.

The content of the configuration file should be a single array containing database connection objects as shown below:

#### SQLite database configuration file example

```
[
  {
    "type": "sqlite",
    "path": "/home/path/to/database.sqlite"
  }
]
```

#### MySQL database configuration file example

```
[
  {
    "name": "My test MySQL database", // <-- to identify the connection
    "type": "mysql",
    "host": "<host>",
    "port": "<port>",
    "username": "<username>",
    "password": "<password>",
    "database": "test" // <-- the database to show in VS Code DevDb view
  }
]
```

You can also have more than one connections in the configuration file, e.g.

```
[
  {
    "name": "My test MySQL database", // <-- to identify the connection
    "type": "mysql",
    "host": "<host>",
    "port": "<port>",
    "username": "<username>",
    "password": "<password>",
    "database": "test" // <-- the database to show in VS Code DevDb view
  },
  {
    "type": "sqlite",
    "path": "/home/path/to/database.sqlite"
  }
]
```

> [!TIP]
> You may not want to commit DevDb config file to your version control.
> This is because other devs in your team may be using different database connection details in their local environments.

## Keybinding

Press `Ctrl+K Ctrl+D` to bring up DevDb view

## Supported Databases

The following databases are currently supported:

- MySQL
- SQLite

Support for Postgres and MongoDB will likely be added in a future release.

## Language and Framework Integrations

- Laravel model Code Lens for viewing Eloquent model underlying table

  ![image](https://private-user-images.githubusercontent.com/9839355/289943291-1a2a5b6c-73bc-4a79-a088-fa4399820550.png?jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTEiLCJleHAiOjE3MDI0MjgyOTgsIm5iZiI6MTcwMjQyNzk5OCwicGF0aCI6Ii85ODM5MzU1LzI4OTk0MzI5MS0xYTJhNWI2Yy03M2JjLTRhNzktYTA4OC1mYTQzOTk4MjA1NTAucG5nP1gtQW16LUFsZ29yaXRobT1BV1M0LUhNQUMtU0hBMjU2JlgtQW16LUNyZWRlbnRpYWw9QUtJQUlXTkpZQVg0Q1NWRUg1M0ElMkYyMDIzMTIxMyUyRnVzLWVhc3QtMSUyRnMzJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyMzEyMTNUMDAzOTU4WiZYLUFtei1FeHBpcmVzPTMwMCZYLUFtei1TaWduYXR1cmU9YWQ2MmY5ZWU0ZjJhOTRjYmQzYzZiZGU1ZDBiODgyMzg5MTg2NWNiM2Y3MWE4MzUwNjNhMDMwNmE3NjljYjg2OSZYLUFtei1TaWduZWRIZWFkZXJzPWhvc3QmYWN0b3JfaWQ9MCZrZXlfaWQ9MCZyZXBvX2lkPTAifQ.yLIutHmDGOUYTCHNS1WokgCO1aZcCuWp71GrWwORhLc)

- Context Menu entry for any table (framework/programming language-agnostic)

  Example from a Node JS app (a [Sequelize model definition](https://sequelize.org/docs/v6/core-concepts/model-basics/#model-definition))

  ![image](https://private-user-images.githubusercontent.com/9839355/289949296-fb9968c3-ee01-43a5-ba2f-65dd455f83a2.png?jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTEiLCJleHAiOjE3MDI0MjgyOTgsIm5iZiI6MTcwMjQyNzk5OCwicGF0aCI6Ii85ODM5MzU1LzI4OTk0OTI5Ni1mYjk5NjhjMy1lZTAxLTQzYTUtYmEyZi02NWRkNDU1ZjgzYTIucG5nP1gtQW16LUFsZ29yaXRobT1BV1M0LUhNQUMtU0hBMjU2JlgtQW16LUNyZWRlbnRpYWw9QUtJQUlXTkpZQVg0Q1NWRUg1M0ElMkYyMDIzMTIxMyUyRnVzLWVhc3QtMSUyRnMzJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyMzEyMTNUMDAzOTU4WiZYLUFtei1FeHBpcmVzPTMwMCZYLUFtei1TaWduYXR1cmU9OTM0YjJiODExYWEwNDU5MzRhM2M4MjZlZDAxMTNhOWU5Zjc5NGNmMmQxMzJlNjc2YzViMzJiMDViZDM3NmYzYyZYLUFtei1TaWduZWRIZWFkZXJzPWhvc3QmYWN0b3JfaWQ9MCZrZXlfaWQ9MCZyZXBvX2lkPTAifQ.HRcc8n0WVoXTODwQrPGQLZKGBJKaoHozZ45iN1U8a70)

## Why DevDb?

Two words: Better DX.

DevDb aims to be a DB GUI client specifically designed for a much better development experience when working with databases.
Specifically, these experiences:

1. For any new project, it is usually required to setup db connection in the app project, **and** then in some other DB client.
2. It is common to frequently tab-in and tab-out of project windows, switching between the IDE and DB client. Sometimes, frequent enough to want to view the DB data directly in the IDE. Think of how you've got your in-built terminal right in the IDE.

Local DX should be better than this.

Also, most of the DB clients are clunky or simply overwhelming, with bells and whistles that are not really useful during local development flow. Usually, being able to simply _view_ DB data is all that is needed during local development.

Furthermore, who doesn't love beautiful UIs? DB clients have evolved to generally not have exciting UIs in my opinion, except just a few with excellent and intuitive UIs.

To address the above, there is a need for a database GUI tool that lives in the IDE, and mostly auto-detects and connects with the database configured in the currently opened workspace. It should be simple, fast, intuitive, and clean.

Hence, DevDb 🚀

## Disclaimer

DevDb does not aim to provide feature-parity with popular GUI database clients. This extension is focused on improving the experience of working with databases during application development.
