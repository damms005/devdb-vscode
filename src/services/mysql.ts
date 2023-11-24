import { Sequelize } from "sequelize";

export async function connectToMysql(host: string, port: number, username: string, password: string, database: string): Promise<Sequelize | undefined> {
	try {
		const sequelize = new Sequelize({ dialect: 'mysql', host, port: port, username, password, database, logging: false });
		await sequelize.authenticate();
		return sequelize
	} catch (error) {
		return
	}
}