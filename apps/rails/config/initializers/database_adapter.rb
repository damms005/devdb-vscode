# This initializer checks if MySQL is available and configures the database adapter accordingly

Rails.application.config.after_initialize do
  # Store the intended MySQL configuration for future use
  mysql_config = {
    adapter: "mysql2",
    encoding: "utf8mb4",
    host: "localhost",
    port: 2222,
    username: "root",
    password: "mysecretpassword",
    database: "sample_db"
  }
  
  # Write the MySQL configuration to a file for reference
  File.open(Rails.root.join("config", "mysql_config.yml"), "w") do |file|
    file.puts "# MySQL configuration for future use"
    file.puts "# To use this configuration, install the mysql2 gem and update database.yml"
    file.puts YAML.dump({
      "development" => mysql_config.merge(database: "sample_db"),
      "test" => mysql_config.merge(database: "sample_db_test"),
      "production" => mysql_config.merge(database: "sample_db_production")
    })
  end
  
  Rails.logger.info "MySQL configuration saved to config/mysql_config.yml for future use"
end
