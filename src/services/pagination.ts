export type PaginationData = {
	currentPage: number;
	firstRowOnPage: number;
	lastRowOnPage: number;
	totalRows: number;
	prevPage?: number;
	nextPage?: number;
	endPage?: number;
	itemsPerPage: number;
	displayText: string;
};

export function getPaginationFor(table: string, page: number, totalRows: number, itemsPerPage: number): PaginationData {
	if (totalRows === 0) {
		return {
			currentPage: 1,
			firstRowOnPage: 0,
			lastRowOnPage: 0,
			totalRows: totalRows,
			endPage: 1,
			itemsPerPage,
			displayText: `Showing 0 to 0 of 0 records`
		};
	}

	const endPage = Math.ceil(totalRows / itemsPerPage);
	// Ensure the current page is within valid bounds
	const validPage = Math.min(Math.max(page, 1), endPage);

	const firstRowOnPage = (validPage - 1) * itemsPerPage + 1;
	const lastRowOnPage = validPage === endPage ? totalRows : validPage * itemsPerPage;

	return {
		currentPage: validPage,
		firstRowOnPage,
		lastRowOnPage,
		totalRows: totalRows,
		prevPage: validPage > 1 ? validPage - 1 : undefined,
		nextPage: validPage < endPage ? validPage + 1 : undefined,
		endPage,
		itemsPerPage,
		displayText: `Showing ${firstRowOnPage.toLocaleString()} to ${lastRowOnPage.toLocaleString()} of ${totalRows.toLocaleString()} records`
	};
}